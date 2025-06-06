import { getProjectionMatrix, getViewMatrix, rotate4, multiply4, invert4, translate4, float16ToFloat32 } from "./src/utils/mathUtils.js";
import { attachShaders, preventDefault, padZeroStart, FTYPES, sleep, setTexture, createErrorSystem } from "./src/utils/utils.js";
import { BitonicSorter, DepthCalculator } from "./src/utils/WGPUSort.js";
import { Manager } from "./src/Manager.js";
import { GPUProfiler } from "./src/GPUProfiler.js";
import { GPUSorter } from "./src/GPUSorter.js";

const ToolWorkerUrl = './src/workers/toolWorker.js';
const PlyDownloaderUrl = './src/workers/plyDownloader.js';
const VideoDownloaderUrl = './src/workers/videoDownloader.js';
const VideoExtracterUrl = './src/workers/videoExtracter.js';
const CBDownloaderUrl = './src/workers/cbDownloader.js';

let cameras = [
  {
    id: 0,
    img_name: "00001",
    width: 1959,
    height: 1090,
    position: [-3.0089893469241797, -0.11086489695181866, -3.7527640949141428],
    rotation: [
      [0.876134201218856, 0.06925962026449776, 0.47706599800804744],
      [-0.04747421839895102, 0.9972110940209488, -0.057586739349882114],
      [-0.4797239414934443, 0.027805376500959853, 0.8769787916452908],
    ],
    fy: 1164.6601287484507,
    fx: 1159.5880733038064,
  },
];

let camera = cameras[0];
let defaultViewMatrix = [
  0.99, -0.023, 0.286, 0,
  0.011, 0.984, 0.163, 0,
  -0.28, -0.16, 0.944, 0,
  1.501, -0.13, 0.500, 1
];
let viewMatrix = defaultViewMatrix;
let gsvMeta = {};
let keyframes = [];
let manager = new Manager();
let plyTexData = new Uint32Array();
let cbTexData = new Uint32Array();
let gpuPositionData = new Float32Array();
let playing = false;

async function main() {
  let carousel = false;
  let wgpuErrorSystem = null;
  let profiler = null;
  let gpuSorter = null;
  const params = new URLSearchParams(location.search);
  try {
    viewMatrix = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    carousel = false;
  } catch (err) { }

  const vertexShaderSource = await (await fetch('./shaders/gsv.vert')).text();
  const fragmentShaderSource = await (await fetch('./shaders/gsv.frag')).text();
  const depthShaderSource = await (await fetch('./shaders/calcDepths.wgsl')).text();
  const sortShaderSource = await (await fetch('./shaders/bitonicSort.wgsl')).text();
  const unrollShaderSource = await (await fetch('./shaders/unrollIndices.wgsl')).text();
  // set up shader code
  BitonicSorter.setShader(sortShaderSource);
  DepthCalculator.setShader(depthShaderSource);
  // gpu device
  const device = await GPUProfiler.createGpuDevice();
  const USEWGPU = (!!device && !params.get('use_cpu'));

  const toolWorker = new Worker(ToolWorkerUrl, { type: 'module' });
  const plyDownloader = new Worker(PlyDownloaderUrl, { type: 'module' });
  const videoDownloader = new Worker(VideoDownloaderUrl, { type: 'module' });
  const videoExtracter = new Worker(VideoExtracterUrl, { type: 'module' });
  const cbdownloader = new Worker(CBDownloaderUrl, { type: 'module' });
  videoDownloader.postMessage({ msg: 'init' });
  videoExtracter.postMessage({ msg: 'init' });
  cbdownloader.postMessage({ msg: 'init' });
  plyDownloader.postMessage({ msg: 'init' });
  const canvas = document.getElementById("canvas");
  const fps = document.getElementById("fps");
  // control bar
  const progressContainer = document.getElementById('progress-background');
  const playedBar = document.getElementById('played-bar');
  const progressBall = document.getElementById('progress-ball');
  let projectionMatrix;

  const gl = canvas.getContext("webgl2", {
    antialias: false,
  });
  // terminate if webgl2 is not supported
  if (!gl) {
    throw new Error("WebGL2 is not supported");
  }

  const program = attachShaders(gl, vertexShaderSource, fragmentShaderSource);
  gl.disable(gl.DEPTH_TEST); // Disable depth testing

  // Enable blending
  gl.enable(gl.BLEND);
  gl.blendFuncSeparate(gl.ONE_MINUS_DST_ALPHA, gl.ONE, gl.ONE_MINUS_DST_ALPHA, gl.ONE);
  gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);

  const u_projection = gl.getUniformLocation(program, "projection");
  const u_viewport = gl.getUniformLocation(program, "viewport");
  const u_focal = gl.getUniformLocation(program, "focal");
  const u_view = gl.getUniformLocation(program, "view");
  const u_timestamp = gl.getUniformLocation(program, "timestamp");
  const u_resolution = gl.getUniformLocation(program, "resolution");
  const u_offsetBorder = gl.getUniformLocation(program, "offset_border");
  const u_extent = gl.getUniformLocation(program, "extent");
  const u_cameraCenter = gl.getUniformLocation(program, "camera_center");
  const u_gop = gl.getUniformLocation(program, "gop");
  const u_overlap = gl.getUniformLocation(program, "overlap");
  const u_duration = gl.getUniformLocation(program, "duration");
  const u_dynamics = gl.getUniformLocation(program, "dynamics");
  // for overlap
  const u_oldynamics = gl.getUniformLocation(program, "oldynamics");

  // positions
  const triangleVertices = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, triangleVertices, gl.STATIC_DRAW);
  const a_position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(a_position);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

  var gsTexture = gl.createTexture();
  var atlasTexture = gl.createTexture();
  var highxyzTexture = gl.createTexture();
  var lowxyzTexture = gl.createTexture();
  var rotTexture = gl.createTexture();
  var olhighxyzTexture = gl.createTexture();
  var ollowxyzTexture = gl.createTexture();
  var olrotTexture = gl.createTexture();
  var shTexture = gl.createTexture();

  var gs_textureLocation = gl.getUniformLocation(program, "gs_texture");
  gl.uniform1i(gs_textureLocation, 0);
  var atlas_textureLocation = gl.getUniformLocation(program, "atlas_texture");
  gl.uniform1i(atlas_textureLocation, 1);
  var highxyz_textureLocation = gl.getUniformLocation(program, "highxyz_texture");
  gl.uniform1i(highxyz_textureLocation, 2);
  var lowxyz_textureLocation = gl.getUniformLocation(program, "lowxyz_texture");
  gl.uniform1i(lowxyz_textureLocation, 3);
  var rot_textureLocation = gl.getUniformLocation(program, "rot_texture");
  gl.uniform1i(rot_textureLocation, 4);
  // for overlap
  var olhighxyz_textureLocation = gl.getUniformLocation(program, "olhighxyz_texture");
  gl.uniform1i(olhighxyz_textureLocation, 5);
  var ollowxyz_textureLocation = gl.getUniformLocation(program, "ollowxyz_texture");
  gl.uniform1i(ollowxyz_textureLocation, 6);
  var olrot_textureLocation = gl.getUniformLocation(program, "olrot_texture");
  gl.uniform1i(olrot_textureLocation, 7);
  // for high-order sh
  var sh_textureLocation = gl.getUniformLocation(program, "sh_texture");
  gl.uniform1i(sh_textureLocation, 8);

  const indexBuffer = gl.createBuffer();
  const a_index = gl.getAttribLocation(program, "index");
  gl.enableVertexAttribArray(a_index);
  gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
  gl.vertexAttribIPointer(a_index, 1, gl.INT, false, 0, 0);
  gl.vertexAttribDivisor(a_index, 1);

  const resize = () => {
    gl.uniform2fv(u_focal, new Float32Array([camera.fx, camera.fy]));

    projectionMatrix = getProjectionMatrix(camera.fx, camera.fy, innerWidth, innerHeight);

    gl.uniform2fv(u_viewport, new Float32Array([innerWidth, innerHeight]));

    gl.canvas.width = Math.round(innerWidth);
    gl.canvas.height = Math.round(innerHeight);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    gl.uniformMatrix4fv(u_projection, false, projectionMatrix);
  };

  window.addEventListener("resize", resize);
  resize();

  toolWorker.onmessage = async (e) => {
    if (e.data.texdata) {
      const { texdata, texwidth, texheight, vertexCount2Date } = e.data;
      // save the previous ply here
      plyTexData = texdata;
      setTexture(gl, gsTexture, texdata, texwidth, texheight, 0, '32rgbui');
      manager.appendOneBuffer(null, null, FTYPES.ply);
      vertexCount = vertexCount2Date;
      if (USEWGPU) {
        gpuPositionData = e.data.positions;
      }
      await sleep(100);
      // load next group
      let nextIdx = manager.getNextIndex(FTYPES.ply);
      if (nextIdx < 0) {
        plyDownloader.postMessage({ msg: 'finish' });
      } else {
        plyDownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[nextIdx] });
      }
    } if (e.data.cbtexdata) {
      const { cbtexdata, texwidth, texheight } = e.data;
      // save the previous ply here
      cbTexData = cbtexdata;
      setTexture(gl, shTexture, cbtexdata, texwidth, texheight, 8, '32rgbui');
      manager.appendOneBuffer(null, null, FTYPES.cb);
      await sleep(100);
      // load next group
      let nextIdx = manager.getNextIndex(FTYPES.cb);
      if (nextIdx < 0) {
        cbdownloader.postMessage({ msg: 'finish' });
      } else {
        cbdownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[nextIdx] });
      }
    }
    else if (e.data.depthIndex) {
      const { depthIndex, viewProj, vertexCount2Date } = e.data;
      gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
      vtx2draw = vertexCount2Date;
    }
  };

  plyDownloader.onmessage = async (e) => {
    if (e.data.msg && e.data.msg == 'ready') {
      manager.initDrcDecoder();
    } else if (e.data.type && e.data.type == FTYPES.ply) {
      const { data, keyframe, type, speed } = e.data;
      if (keyframe == -1) {
        // process the initial ply
        while (!manager.initCb) {
          await sleep(100);
        }
        USEWGPU ?
          toolWorker.postMessage({
            ply: data, groupIdx: -1, positions: gpuPositionData,
            total: gsvMeta.total_gaussians, tex: plyTexData, usegpu: USEWGPU
          }, [data.buffer, plyTexData.buffer, gpuPositionData.buffer])
          : toolWorker.postMessage({
            ply: data, groupIdx: -1,
            total: gsvMeta.total_gaussians, tex: plyTexData, usegpu: USEWGPU
          }, [data.buffer, plyTexData.buffer]);
      } else {
        // check if the init ply is loaded & if the meta data is ready
        // to ensure in-order processing
        while (vertexCount == 0 || !manager.cbBuffer[keyframe] || !plyTexData) {
          await sleep(100);
        }
        USEWGPU ?
          toolWorker.postMessage({
            ply: data, groupIdx: parseInt(keyframe) / gsvMeta.GOP, positions: gpuPositionData,
            total: -1, tex: plyTexData, usegpu: USEWGPU
          }, [data.buffer, plyTexData.buffer, gpuPositionData.buffer])
          : toolWorker.postMessage({
            ply: data, groupIdx: parseInt(keyframe) / gsvMeta.GOP,
            total: -1, tex: plyTexData, usegpu: USEWGPU
          }, [data.buffer, plyTexData.buffer]);
      }
      // if (keyframe == keyframes[keyframes.length - 1]) {
      //   document.getElementById("speed").innerText = '';
      // } else {
      //   var _speed = parseFloat(document.getElementById("speed").innerText.split(' ')[2]) * .6 + speed * .4;
      //   document.getElementById("speed").innerText = 'estimated speed: ' + _speed.toFixed(2) + ' MB/s';
      // }
      // set undefined to ensure in-order processing
      plyTexData = undefined;
    }
  };

  videoExtracter.onmessage = async (e) => {
    if (e.data.msg && e.data.msg == 'ready') {
      manager.initExtracter();
    } else if (e.data.type && e.data.type >= FTYPES.highxyz && e.data.type <= FTYPES.rot) {
      const { data, keyframe, type } = e.data;
      for (let i = 0; i < data.buffers.length; i++) {
        const buffer = data.buffers[i].buffer;
        manager.appendOneBuffer(buffer, keyframe, type);
        await sleep(10);
      }
      await sleep(100);
      manager.incrementVideoLoaded(type);
      // load next group
      let nextIdx = manager.getNextIndex(type);
      if (nextIdx < 0) {
        videoDownloader.postMessage({ msg: 'finish' });
      } else {
        videoDownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[nextIdx], type: type });
      }
    }
  };

  videoDownloader.onmessage = async (e) => {
    if (e.data.msg && e.data.msg == 'ready') {
      // do nothing
    } else if (e.data.type) {
      const { data, keyframe, type, speed } = e.data;
      // if (type != FTYPES.rot && keyframe == keyframes[keyframes.length - 1]) {
      //   document.getElementById("speed").innerText = '';
      // } else if (type != FTYPES.rot) {
      //   document.getElementById("speed").innerText = 'estimated speed: ' + speed.toFixed(2) + ' MB/s';
      // }
      videoExtracter.postMessage({ data: data, keyframe: keyframe, type: type }, [data]);
    }
  };

  cbdownloader.onmessage = async (e) => {
    if (e.data.msg && e.data.msg == 'ready') {
      // do nothing
    } else if (e.data.type && e.data.type == FTYPES.cb) {
      const { cbjson, data, keyframe, type } = e.data;
      if (keyframe == -1) {
        const totalCBIndex = 2048 * keyframes.length + 1024;
        // process the initial codebook
        toolWorker.postMessage({ cb: data, total: totalCBIndex, groupIdx: -1, tex: cbTexData }, [data, cbTexData.buffer]);
        manager.setInitCb(cbjson);
        gl.uniform1f(u_extent, manager.initCb.extent);
      } else {
        manager.appendOneBuffer(cbjson, keyframe, type);
        const groupIdx = parseInt(keyframe) / gsvMeta.GOP;
        // to ensure in-order processing
        while (!cbTexData) {
          await sleep(100);
        }
        toolWorker.postMessage({ cb: data, total: 0, groupIdx: groupIdx, tex: cbTexData }, [data, cbTexData.buffer]);
      }
      // set undefined to ensure in-order processing
      cbTexData = undefined;
    }
  };

  toolWorker.onerror = (e) => {
    console.error(e.toString(), 'worker error');
    throw new Error(e);
  }

  plyDownloader.onerror = (e) => {
    console.error(e.toString(), 'plyDownloader error');
    throw new Error(e);
  }

  videoExtracter.onerror = (e) => {
    console.error(e.toString(), 'videoExtracter error');
    throw new Error(e);
  }

  videoDownloader.onerror = (e) => {
    console.error(e.toString(), 'videoDownloader error');
    throw new Error(e);
  }

  cbdownloader.onerror = (e) => {
    console.error(e.toString(), 'cbdownloader error');
    throw new Error(e);
  }

  const sortGS = async (viewProj) => {
    if (vertexCount <= 0) {
      return;
    }
    // should work after profiler & gpuSorter initialized
    if (USEWGPU && profiler && gpuSorter) {
      wgpuErrorSystem?.startErrorScope('sort');
      // profiler.profileNextFrame(true);
      profiler.beginFrame();
      // record commands
      const cmdBuf = device.createCommandEncoder({
        label: 'sort-cmd',
      });
      gpuSorter.cmdSortByDepth({
        cmdBuf,
        device,
        profiler,
        viewProj,
        currentVertexCount: vertexCount,
        positions: gpuPositionData
      });
      profiler.endFrame(cmdBuf);
      device.queue.submit([cmdBuf.finish()]);
      gpuSorter.getDepthIndex().then(res => {
        if (res != null) {
          gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, res.depthIndex, gl.DYNAMIC_DRAW);
          // number of sorted gs and number of restored gs are not the same due to asynchronization
          vtx2draw = res.cnt;
        }
      })
      profiler.scheduleReportIfNeededAsync((res) => { console.log('Profiler: ', res); });

      wgpuErrorSystem?.reportErrorScopeAsync((lastError) => {
        throw new Error(lastError);
      });
    } else { toolWorker.postMessage({ view: viewProj, currentVertexCount: vertexCount }) };
  }

  let activeKeys = [];
  let currentCameraIndex = 0;

  window.addEventListener("keydown", (e) => {
    // if (document.activeElement != document.body) return;
    carousel = false;
    if (!activeKeys.includes(e.code)) activeKeys.push(e.code);
    if (/\d/.test(e.key)) {
      currentCameraIndex = parseInt(e.key);
      camera = cameras[currentCameraIndex];
      viewMatrix = getViewMatrix(camera);
    }
    if (["-", "_"].includes(e.key)) {
      currentCameraIndex = (currentCameraIndex + cameras.length - 1) % cameras.length;
      viewMatrix = getViewMatrix(cameras[currentCameraIndex]);
    }
    if (["+", "="].includes(e.key)) {
      currentCameraIndex = (currentCameraIndex + 1) % cameras.length;
      viewMatrix = getViewMatrix(cameras[currentCameraIndex]);
    }
    if (e.code == "KeyV") {
      location.hash = "#" + JSON.stringify(viewMatrix.map((k) => Math.round(k * 100) / 100));
    } else if (e.code === "KeyP") {
      carousel = true;
    }
  });

  window.addEventListener("keyup", (e) => {
    activeKeys = activeKeys.filter((k) => k !== e.code);
  });
  window.addEventListener("blur", () => {
    activeKeys = [];
  });

  window.addEventListener(
    "wheel",
    (e) => {
      carousel = false;
      e.preventDefault();
      const lineHeight = 10;
      const scale = e.deltaMode == 1 ? lineHeight : e.deltaMode == 2 ? innerHeight : 1;
      let inv = invert4(viewMatrix);
      if (e.shiftKey) {
        inv = translate4(inv, (e.deltaX * scale) / innerWidth, (e.deltaY * scale) / innerHeight, 0);
      } else if (e.ctrlKey || e.metaKey) {
        // inv = rotate4(inv,  (e.deltaX * scale) / innerWidth,  0, 0, 1);
        // inv = translate4(inv,  0, (e.deltaY * scale) / innerHeight, 0);
        // let preY = inv[13];
        inv = translate4(inv, 0, 0, (-10 * (e.deltaY * scale)) / innerHeight);
        // inv[13] = preY;
      } else {
        let d = 4;
        inv = translate4(inv, 0, 0, d);
        inv = rotate4(inv, -(e.deltaX * scale) / innerWidth, 0, 1, 0);
        inv = rotate4(inv, (e.deltaY * scale) / innerHeight, 1, 0, 0);
        inv = translate4(inv, 0, 0, -d);
      }

      viewMatrix = invert4(inv);
    },
    { passive: false }
  );

  let startX, startY, down;
  canvas.addEventListener("mousedown", (e) => {
    carousel = false;
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    down = e.ctrlKey || e.metaKey ? 2 : 1;
  });
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  canvas.addEventListener("mousemove", (e) => {
    e.preventDefault();
    if (down == 1) {
      let inv = invert4(viewMatrix);
      let dx = (5 * (e.clientX - startX)) / innerWidth;
      let dy = (5 * (e.clientY - startY)) / innerHeight;
      let d = 4;

      inv = translate4(inv, 0, 0, d);
      inv = rotate4(inv, dx, 0, 1, 0);
      inv = rotate4(inv, -dy, 1, 0, 0);
      inv = translate4(inv, 0, 0, -d);
      // let postAngle = Math.atan2(inv[0], inv[10])
      // inv = rotate4(inv, postAngle - preAngle, 0, 0, 1)
      // console.log(postAngle)
      viewMatrix = invert4(inv);

      startX = e.clientX;
      startY = e.clientY;
    } else if (down == 2) {
      let inv = invert4(viewMatrix);
      // inv = rotateY(inv, );
      // let preY = inv[13];
      inv = translate4(inv, (-10 * (e.clientX - startX)) / innerWidth, 0, (10 * (e.clientY - startY)) / innerHeight);
      // inv[13] = preY;
      viewMatrix = invert4(inv);

      startX = e.clientX;
      startY = e.clientY;
    }
  });
  canvas.addEventListener("mouseup", (e) => {
    e.preventDefault();
    down = false;
    startX = 0;
    startY = 0;
  });

  let altX = 0,
    altY = 0;
  canvas.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      if (e.touches.length === 1) {
        carousel = false;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        down = 1;
      } else if (e.touches.length === 2) {
        // console.log('beep')
        carousel = false;
        startX = e.touches[0].clientX;
        altX = e.touches[1].clientX;
        startY = e.touches[0].clientY;
        altY = e.touches[1].clientY;
        down = 1;
      }
    },
    { passive: false }
  );
  canvas.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && down) {
        let inv = invert4(viewMatrix);
        let dx = (4 * (e.touches[0].clientX - startX)) / innerWidth;
        let dy = (4 * (e.touches[0].clientY - startY)) / innerHeight;

        let d = 4;
        inv = translate4(inv, 0, 0, d);
        // inv = translate4(inv,  -x, -y, -z);
        // inv = translate4(inv,  x, y, z);
        inv = rotate4(inv, dx, 0, 1, 0);
        inv = rotate4(inv, -dy, 1, 0, 0);
        inv = translate4(inv, 0, 0, -d);

        viewMatrix = invert4(inv);

        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        // alert('beep')
        const dtheta =
          Math.atan2(startY - altY, startX - altX) -
          Math.atan2(e.touches[0].clientY - e.touches[1].clientY, e.touches[0].clientX - e.touches[1].clientX);
        const dscale =
          Math.hypot(startX - altX, startY - altY) /
          Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        const dx = (e.touches[0].clientX + e.touches[1].clientX - (startX + altX)) / 2;
        const dy = (e.touches[0].clientY + e.touches[1].clientY - (startY + altY)) / 2;
        let inv = invert4(viewMatrix);
        // inv = translate4(inv,  0, 0, d);
        inv = rotate4(inv, dtheta, 0, 0, 1);

        inv = translate4(inv, -dx / innerWidth, -dy / innerHeight, 0);

        // let preY = inv[13];
        inv = translate4(inv, 0, 0, 3 * (1 - dscale));
        // inv[13] = preY;

        viewMatrix = invert4(inv);

        startX = e.touches[0].clientX;
        altX = e.touches[1].clientX;
        startY = e.touches[0].clientY;
        altY = e.touches[1].clientY;
      }
    },
    { passive: false }
  );
  canvas.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      down = false;
      startX = 0;
      startY = 0;
    },
    { passive: false }
  );

  // ** animation loop ** //
  let jumpDelta = 0;
  let vertexCount = 0;
  let vtx2draw = 0;

  // time for last frame to control fps
  let lastFrame = 0;
  // to measure rendering fps
  let lastFpsTime = 0;
  let avgFps = 0;
  let start = 0;
  let targetFPSInterval = 1000 / 30;

  const frame = (now) => {
    let inv = invert4(viewMatrix);
    let shiftKey = activeKeys.includes("Shift") || activeKeys.includes("ShiftLeft") || activeKeys.includes("ShiftRight");

    if (activeKeys.includes("ArrowUp")) {
      if (shiftKey) {
        inv = translate4(inv, 0, -0.03, 0);
      } else {
        inv = translate4(inv, 0, 0, 0.1);
      }
    }
    if (activeKeys.includes("ArrowDown")) {
      if (shiftKey) {
        inv = translate4(inv, 0, 0.03, 0);
      } else {
        inv = translate4(inv, 0, 0, -0.1);
      }
    }
    if (activeKeys.includes("ArrowLeft")) inv = translate4(inv, -0.03, 0, 0);
    //
    if (activeKeys.includes("ArrowRight")) inv = translate4(inv, 0.03, 0, 0);
    // inv = rotate4(inv, 0.01, 0, 1, 0);
    if (activeKeys.includes("KeyA")) inv = rotate4(inv, -0.005, 0, 1, 0);
    if (activeKeys.includes("KeyD")) inv = rotate4(inv, 0.005, 0, 1, 0);
    if (activeKeys.includes("KeyQ")) inv = rotate4(inv, 0.01, 0, 0, 1);
    if (activeKeys.includes("KeyE")) inv = rotate4(inv, -0.01, 0, 0, 1);
    if (activeKeys.includes("KeyW")) inv = rotate4(inv, 0.005, 1, 0, 0);
    if (activeKeys.includes("KeyS")) inv = rotate4(inv, -0.005, 1, 0, 0);
    if (activeKeys.includes("BracketLeft")) {
      camera.fx /= 1.01;
      camera.fy /= 1.01;
      inv = translate4(inv, 0, 0, 0.1);
      resize();
    }
    if (activeKeys.includes("BracketRight")) {
      camera.fx *= 1.01;
      camera.fy *= 1.01;
      inv = translate4(inv, 0, 0, -0.1);
      resize();
    }

    if (["KeyJ", "KeyK", "KeyL", "KeyI"].some((k) => activeKeys.includes(k))) {
      let d = 4;
      inv = translate4(inv, 0, 0, d);
      inv = rotate4(inv, activeKeys.includes("KeyJ") ? -0.05 : activeKeys.includes("KeyL") ? 0.05 : 0, 0, 1, 0);
      inv = rotate4(inv, activeKeys.includes("KeyI") ? 0.05 : activeKeys.includes("KeyK") ? -0.05 : 0, 1, 0, 0);
      inv = translate4(inv, 0, 0, -d);
    }

    viewMatrix = invert4(inv);

    if (carousel) {
      let inv = invert4(defaultViewMatrix);

      const t = Math.sin((Date.now() - start) / 5000);
      inv = translate4(inv, 2.5 * t, 0, 6 * (1 - Math.cos(t)));
      inv = rotate4(inv, -0.6 * t, 0, 1, 0);

      viewMatrix = invert4(inv);
    }

    if (activeKeys.includes("Space")) {
      jumpDelta = Math.min(1, jumpDelta + 0.05);
    } else {
      jumpDelta = Math.max(0, jumpDelta - 0.05);
    }

    let inv2 = invert4(viewMatrix);
    inv2 = translate4(inv2, 0, -jumpDelta, 0);
    inv2 = rotate4(inv2, -0.1 * jumpDelta, 1, 0, 0);
    let actualViewMatrix = invert4(inv2);
    gl.uniform3fv(u_cameraCenter, new Float32Array([inv2[12], inv2[13], inv2[14]]));

    // column-major
    const viewProj = multiply4(projectionMatrix, actualViewMatrix);
    sortGS(viewProj);

    // update fps hint
    const currentFps = 1000 / (now - lastFpsTime) || 0;
    avgFps = (isFinite(avgFps) && avgFps) * 0.9 + currentFps * 0.1;

    if (vtx2draw > 0) {
      var elapsed = now - lastFrame;      // update the frame
      gl.uniformMatrix4fv(u_view, false, actualViewMatrix);
      if (manager.canPlay()) {
        if (elapsed > targetFPSInterval) {
          lastFrame = now - (elapsed % (targetFPSInterval));
          // control fps
          manager.currentFrame = playing ? (manager.currentFrame + 1) % gsvMeta.duration : manager.currentFrame;
          document.getElementById("ts").innerText = manager.currentFrame.toString() + ' / ' + manager.duration.toString();
          gl.uniform1ui(u_timestamp, manager.currentFrame);
          var currentCb = manager.getFromCurrentFrame(FTYPES.cb);
          gl.uniform2iv(u_dynamics, new Int32Array([currentCb.dynamic_start, currentCb.dynamic_end]));
          // directly calculate from image resolution, so no need to divide by another 4
          setTexture(gl, highxyzTexture, manager.getFromCurrentFrame(FTYPES.highxyz), 1024, Math.ceil((gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 2, '8rgbui');
          setTexture(gl, lowxyzTexture, manager.getFromCurrentFrame(FTYPES.lowxyz), 1024, Math.ceil((gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 3, '8rgbui');
          // if to combine the quaternion in shader
          // setTexture(gl, rotTexture, manager.getFromCurrentFrame(FTYPES.rot), 1024, Math.ceil((4 * gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 4, '8rui');
          setTexture(gl, rotTexture, manager.getFromCurrentFrame(FTYPES.rot), 1024, Math.ceil((gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 4, '8rgbaui');

          // for overlap
          var lastCb = manager.getFromOverlapFrame(FTYPES.cb);
          gl.uniform2iv(u_oldynamics, new Int32Array([lastCb.dynamic_start, lastCb.dynamic_end]));
          setTexture(gl, olhighxyzTexture, manager.getFromOverlapFrame(FTYPES.highxyz), 1024, Math.ceil((gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 5, '8rgbui');
          setTexture(gl, ollowxyzTexture, manager.getFromOverlapFrame(FTYPES.lowxyz), 1024, Math.ceil((gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 6, '8rgbui');
          setTexture(gl, olrotTexture, manager.getFromOverlapFrame(FTYPES.rot), 1024, Math.ceil((gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 7, '8rgbaui');

          // update progress control bar
          if (!isDragging) {
            progressBall.style.left = `calc(${(manager.currentFrame / gsvMeta.duration) * 100}% - 8px)`;
            playedBar.style.width = `${(manager.currentFrame / gsvMeta.duration) * 100}%`;
          }
        } else {
          // wait for next frame
        }
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vtx2draw);
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT);
      lastFrame = now;
    }
    fps.innerText = Math.round(avgFps) + " fps";
    lastFpsTime = now;
    requestAnimationFrame(frame);
  };

  frame();
  // ** animation loop ** //

  window.addEventListener("hashchange", (e) => {
    try {
      viewMatrix = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      carousel = false;
    } catch (err) { }
  });


  document.addEventListener("dragenter", preventDefault);
  document.addEventListener("dragover", preventDefault);
  document.addEventListener("dragleave", preventDefault);


  // main work here
  const sceneInput = params.get('scene') ? params.get('scene') : 'flame_salmon_dense';
  const scenesSupport = ['flame_salmon_40s', 'trimming', 'coffee_martini', 'cook_spinach', 'cut_roasted_beef',
    'flame_salmon', 'flame_steak', 'sear_steak', 'discussion', 'UNO', 'flame_salmon_dense'];
  if (!scenesSupport.includes(sceneInput)) {
    throw new Error('Scene not supported!');
  }
  // const baseUrl = 'http://localhost:8080/fragmented/' + sceneInput + '/';
  const baseUrl = 'https://raw.githubusercontent.com/zpqqq10/stream-backend-demo/refs/heads/main/webbackend/' + sceneInput + '/';

  document.getElementById("message").innerText = 'requesting metadata...';

  // not using try: since if this request fails, the player should terminate
  const metaReq = await fetch(new URL('meta.json', baseUrl))
  if (metaReq.status != 200) throw new Error(metaReq.status + " Unable to load " + metaReq.url);
  gsvMeta = await metaReq.json()
  gsvMeta.frameDuration = 1 / (gsvMeta.GOP + gsvMeta.overlap);
  console.info({ gsvMeta })
  targetFPSInterval = 1000 / gsvMeta.target_fps;
  gl.uniform1i(u_offsetBorder, gsvMeta.offset_position_border);
  gl.uniform1i(u_resolution, gsvMeta.image[0]);
  gl.uniform1ui(u_gop, gsvMeta.GOP);
  gl.uniform1ui(u_overlap, gsvMeta.overlap);
  gl.uniform1ui(u_duration, gsvMeta.duration);

  if (USEWGPU) {
    // there is a gpu
    document.getElementById("note2").innerText = 'sort by GPU!'
    console.info(device);
    wgpuErrorSystem = createErrorSystem(device);
    wgpuErrorSystem?.startErrorScope('init');

    // set up renderer
    profiler = new GPUProfiler(device);
    gpuSorter = new GPUSorter(device, gsvMeta.total_gaussians);

    const lastError = await wgpuErrorSystem?.reportErrorScopeAsync();
    if (lastError) {
      throw new Error(lastError);
    }
  }

  const atlasPromise = fetch(`assets/${gsvMeta.image[0]}.bin`)
  const cameraPromise = fetch(new URL('cameras.json', baseUrl))
  keyframes = [];
  for (let index = 0; index < gsvMeta.duration - gsvMeta.overlap; index += gsvMeta.GOP) {
    keyframes.push(padZeroStart((index + gsvMeta.begin_index).toString()));
  }
  manager.setMetaInfo(keyframes.length, gsvMeta.GOP, gsvMeta.overlap, gsvMeta.duration, gsvMeta.target_fps);

  const [cameraReq, atlasReq] = await Promise.all([cameraPromise, atlasPromise]);
  if (cameraReq.status != 200) throw new Error(cameraReq.status + " Unable to load " + cameraReq.url);
  if (atlasReq.status != 200) throw new Error(atlasReq.status + " Unable to load " + atlasReq.url);
  const cameraData = await cameraReq.json()
  cameras = cameraData;
  camera = cameraData[0];
  // update viewMatrix
  viewMatrix = getViewMatrix(camera);
  const atlas = await atlasReq.arrayBuffer();
  // atlas: morton order as the index and return the index in the image
  setTexture(gl, atlasTexture, new Uint32Array(atlas), 1024, Math.ceil((gsvMeta.image[0] * gsvMeta.image[1]) / 1024), 1, '32rui');

  await manager.blockUntilAllReady();
  cbdownloader.postMessage({ baseUrl: baseUrl, keyframe: -1 });
  plyDownloader.postMessage({ baseUrl: baseUrl, keyframe: -1 });
  await sleep(300);


  // current time
  console.log('current time', new Date().toLocaleTimeString());
  videoDownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0], type: FTYPES.highxyz });
  videoDownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0], type: FTYPES.lowxyz });
  videoDownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0], type: FTYPES.rot });

  // control bar
  progressContainer.addEventListener('click', (event) => {
    updateProgress(event.clientX);
    manager.currentFrame = Math.round(parseFloat(playedBar.style.width) / 100 * manager.duration);
  });
  progressContainer.addEventListener('mouseenter', () => {
    progressBall.style.display = 'block';
  });
  progressContainer.addEventListener('mouseleave', () => {
    progressBall.style.display = 'none';
  });

  let isDragging = false;

  progressBall.addEventListener('mousedown', (event) => {
    isDragging = true;
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onMouseUp);
  });

  function updateProgress(positionX) {
    // width of the whole progress bar
    let offsetX = positionX - progressContainer.getBoundingClientRect().left;
    if (offsetX < 0) offsetX = 0;
    if (offsetX > progressContainer.offsetWidth) offsetX = progressContainer.offsetWidth;

    const percentage = (offsetX / progressContainer.offsetWidth) * 100;
    progressBall.style.left = `calc(${percentage}% - 8px)`;
    playedBar.style.width = `${percentage}%`;
  }

  function onDrag(event) {
    if (!isDragging) return;
    updateProgress(event.clientX);
  }

  function onMouseUp() {
    if (isDragging) {
      isDragging = false;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onMouseUp);

      manager.currentFrame = Math.round(parseFloat(playedBar.style.width) / 100 * manager.duration);
    }
  }

  await manager.blockUntilCanplay();

  playing = true;
  document.getElementById("control").style.display = 'flex';
  // document.getElementById("speed").style.display = 'flex';
  var button = document.getElementById("playPauseButton");
  button.addEventListener('click', () => {
    var icon = button.querySelector("i");
    if (playing) {
      playing = false;
      icon.classList.remove("fa-pause");
      icon.classList.add("fa-play");
    } else {
      playing = true;
      icon.classList.remove("fa-play");
      icon.classList.add("fa-pause");
    }
  }
  );

}

main().catch((err) => {
  document.getElementById("message").innerText = err.toString() + '\nPlease check your network or REFRESH';
});

