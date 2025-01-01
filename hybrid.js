import { vertexShaderSource, fragmentShaderSource } from "./shaders/GSTVSahders.js";
import { getProjectionMatrix, getViewMatrix, rotate4, multiply4, invert4, translate4 } from "./src/utils/mathUtils.js";
import { attachShaders, readChunks, padZeroStart, FTYPES, sleep } from "./src/utils/utils.js";
import { Manager } from "./src/Manager.js";

const ToolWorkerUrl = './src/workers/toolWorker.js';
const PlyWorkerUrl = './src/workers/plyWorker.js';
const VideoDownloaderUrl = './src/workers/videoDownloader.js';
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
let defaultViewMatrix = [0.99, 0.01, -0.14, 0, 0.02, 0.99, 0.12, 0, 0.14, -0.12, 0.98, 0, -0.09, -0.26, 0.2, 1];

let viewMatrix = defaultViewMatrix;
let gsvMeta = {};
let keyframes = [];
let manager = new Manager();

async function main() {
  let carousel = false;
  const params = new URLSearchParams(location.search);
  try {
    viewMatrix = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    carousel = false;
  } catch (err) { }

  const rowLength = 3 * 4 + 3 * 4 + 4 + 4;
  let splatData = new Uint8Array([]);
  const downsample = splatData.length / rowLength > 500000 ? 1 : 1 / devicePixelRatio;

  const toolWorker = new Worker(ToolWorkerUrl);
  const plyWorker = new Worker(PlyWorkerUrl, { type: 'module' });
  const downloader = new Worker(VideoDownloaderUrl, { type: 'module' });
  const cbdownloader = new Worker(CBDownloaderUrl, { type: 'module' });
  downloader.postMessage({ msg: 'init' });
  cbdownloader.postMessage({ msg: 'init' });
  plyWorker.postMessage({ msg: 'init' });
  const canvas = document.getElementById("canvas");
  const fps = document.getElementById("fps");

  let projectionMatrix;

  const gl = canvas.getContext("webgl2", {
    antialias: false,
  });

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
  const u_time = gl.getUniformLocation(program, "time");

  // positions
  const triangleVertices = new Float32Array([-2, -2, 2, -2, 2, 2, -2, 2]);
  const vertexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, triangleVertices, gl.STATIC_DRAW);
  const a_position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(a_position);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 0, 0);

  var texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);

  var u_textureLocation = gl.getUniformLocation(program, "u_texture");
  gl.uniform1i(u_textureLocation, 0);

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

    gl.canvas.width = Math.round(innerWidth / downsample);
    gl.canvas.height = Math.round(innerHeight / downsample);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    gl.uniformMatrix4fv(u_projection, false, projectionMatrix);
  };

  window.addEventListener("resize", resize);
  resize();

  toolWorker.onmessage = (e) => {
    if (e.data.texdata) {
      const { texdata, texwidth, texheight } = e.data;

      const json = new TextEncoder().encode(
        JSON.stringify([
          {
            type: "splat",
            size: texdata.byteLength,
            texwidth: texwidth,
            texheight: texheight,
            cameras: cameras,
          },
        ])
      );
      const magic = new Uint32Array(2);
      magic[0] = 0x674b;
      magic[1] = json.length;
      const blob = new Blob([magic.buffer, json.buffer, texdata.buffer], {
        type: "application/octet-stream",
      });

      readChunks(new Response(blob).body.getReader(), [{ size: 8, type: "magic" }], chunkHandler);

      const link = document.createElement("a");
      link.download = "model.splatv";
      link.href = URL.createObjectURL(blob);
      document.body.appendChild(link);
      link.click();
    } else if (e.data.depthIndex) {
      const { depthIndex, viewProj } = e.data;
      gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, depthIndex, gl.DYNAMIC_DRAW);
      vertexCount = e.data.vertexCount;
    }
  };

  plyWorker.onmessage = async (e) => {
    if (e.data.msg && e.data.msg == 'ready') {
      document.getElementById("message").innerText = 'ply decoder ready';
      manager.initDrcDecoder();
    } else if (e.data.type && e.data.type == FTYPES.ply) {
      const { data, keyframe, type } = e.data;
      // const plyDataBuffer = new Uint8Array(data);
      manager.appendOneBuffer(data, keyframe, type);
      // load next group
      let nextIdx = manager.getNextIndex(type);
      if (nextIdx < 0) {
        plyWorker.postMessage({ msg: 'finish' });
      } else {
        plyWorker.postMessage({ baseUrl: baseUrl, keyframe: keyframes[nextIdx] });
      }
    }
  };

  downloader.onmessage = async (e) => {
    if (e.data.msg && e.data.msg == 'ready') {
      // do nothing
    } else if (e.data.type) {
      const { data, keyframe, type } = e.data;
      // const plyDataBuffer = new Uint8Array(data);
      // determine which to use
      let videoEleName = '';
      let canvasEleName = '';
      switch (type) {
        case FTYPES.lowxyz:
          videoEleName = 'lowxyzVideo';
          canvasEleName = 'lowxyzCanvas';
          break;
        case FTYPES.highxyz:
          videoEleName = 'highxyzVideo';
          canvasEleName = 'highxyzCanvas';
          break;
        case FTYPES.rot:
          videoEleName = 'rotVideo';
          canvasEleName = 'rotCanvas';
          break;
        default:
          throw new Error('unknown type');
      }

      const videoEle = document.getElementById(videoEleName);
      const canvasEle = document.getElementById(canvasEleName);
      const captureCtx = canvasEle.getContext('2d', { willReadFrequently: true });

      const blob = new Blob([data], { type: 'video/mp4' });
      const videoUrl = URL.createObjectURL(blob);
      videoEle.src = videoUrl;

      // TODO 这里可能会有性能问题
      await startFrameCapture();
      async function startFrameCapture() {
        try {
          // 确保视频可以播放
          await new Promise((resolve, reject) => {
            videoEle.oncanplay = resolve;
            videoEle.onerror = reject;
          });

          // 开始逐帧捕获
          for (let currentTime = 0; currentTime < videoEle.duration; currentTime += gsvMeta.frameDuration) {

            videoEle.pause()
            videoEle.currentTime = currentTime;
            await new Promise((resolve) => {
              videoEle.onseeked = resolve;
            });

            // 捕获当前帧
            captureCtx.drawImage(videoEle, 0, 0, canvasEle.width, canvasEle.height);

            // 获取帧的像素数据
            const imageData = captureCtx.getImageData(0, 0, canvasEle.width, canvasEle.height);
            manager.appendOneBuffer(imageData.data.buffer, keyframe, type);
          }
          manager.incrementVideoLoaded(type);

          let nextIdx = manager.getNextIndex(type);
          if (nextIdx < 0) {
            downloader.postMessage({ msg: 'finish' });
          } else {
            downloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[nextIdx], type: type });
          }
        } catch (error) {
          console.error('Error during frame capture:', error);
        }
      }

    }
  };

  cbdownloader.onmessage = async (e) => {
    if (e.data.msg && e.data.msg == 'ready') {
      // do nothing
    } else if (e.data.type && e.data.type == FTYPES.cb) {
      const { data, keyframe, type } = e.data;
      // const plyDataBuffer = new Uint8Array(data);
      manager.appendOneBuffer(data, keyframe, type);
      // load next group
      let nextIdx = manager.getNextIndex(type);
      if (nextIdx < 0) {
        cbdownloader.postMessage({ msg: 'finish' });
      } else {
        cbdownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[nextIdx] });
      }
    }
  };

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
    // console.log("contextmenu?");
    // carousel = false;
    e.preventDefault();
    // startX = e.clientX;
    // startY = e.clientY;
    // down = 2;
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

  let jumpDelta = 0;
  let vertexCount = 0;

  let lastFrame = 0;
  let avgFps = 0;
  let start = 0;

  let leftGamepadTrigger, rightGamepadTrigger;

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
    if (activeKeys.includes("KeyA")) inv = rotate4(inv, -0.01, 0, 1, 0);
    if (activeKeys.includes("KeyD")) inv = rotate4(inv, 0.01, 0, 1, 0);
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
    // console.log(activeKeys);

    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    let isJumping = activeKeys.includes("Space");
    for (let gamepad of gamepads) {
      if (!gamepad) continue;

      const axisThreshold = 0.1; // Threshold to detect when the axis is intentionally moved
      const moveSpeed = 0.06;
      const rotateSpeed = 0.02;

      // Assuming the left stick controls translation (axes 0 and 1)
      if (Math.abs(gamepad.axes[0]) > axisThreshold) {
        inv = translate4(inv, moveSpeed * gamepad.axes[0], 0, 0);
        carousel = false;
      }
      if (Math.abs(gamepad.axes[1]) > axisThreshold) {
        inv = translate4(inv, 0, 0, -moveSpeed * gamepad.axes[1]);
        carousel = false;
      }
      if (gamepad.buttons[12].pressed || gamepad.buttons[13].pressed) {
        inv = translate4(inv, 0, -moveSpeed * (gamepad.buttons[12].pressed - gamepad.buttons[13].pressed), 0);
        carousel = false;
      }

      if (gamepad.buttons[14].pressed || gamepad.buttons[15].pressed) {
        inv = translate4(inv, -moveSpeed * (gamepad.buttons[14].pressed - gamepad.buttons[15].pressed), 0, 0);
        carousel = false;
      }

      // Assuming the right stick controls rotation (axes 2 and 3)
      if (Math.abs(gamepad.axes[2]) > axisThreshold) {
        inv = rotate4(inv, rotateSpeed * gamepad.axes[2], 0, 1, 0);
        carousel = false;
      }
      if (Math.abs(gamepad.axes[3]) > axisThreshold) {
        inv = rotate4(inv, -rotateSpeed * gamepad.axes[3], 1, 0, 0);
        carousel = false;
      }

      let tiltAxis = gamepad.buttons[6].value - gamepad.buttons[7].value;
      if (Math.abs(tiltAxis) > axisThreshold) {
        inv = rotate4(inv, rotateSpeed * tiltAxis, 0, 0, 1);
        carousel = false;
      }
      if (gamepad.buttons[4].pressed && !leftGamepadTrigger) {
        camera = cameras[(cameras.indexOf(camera) + 1) % cameras.length];
        inv = invert4(getViewMatrix(camera));
        carousel = false;
      }
      if (gamepad.buttons[5].pressed && !rightGamepadTrigger) {
        camera = cameras[(cameras.indexOf(camera) + cameras.length - 1) % cameras.length];
        inv = invert4(getViewMatrix(camera));
        carousel = false;
      }
      leftGamepadTrigger = gamepad.buttons[4].pressed;
      rightGamepadTrigger = gamepad.buttons[5].pressed;
      if (gamepad.buttons[0].pressed) {
        isJumping = true;
        carousel = false;
      }
      if (gamepad.buttons[3].pressed) {
        carousel = true;
      }
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

    if (isJumping) {
      jumpDelta = Math.min(1, jumpDelta + 0.05);
    } else {
      jumpDelta = Math.max(0, jumpDelta - 0.05);
    }

    let inv2 = invert4(viewMatrix);
    inv2 = translate4(inv2, 0, -jumpDelta, 0);
    inv2 = rotate4(inv2, -0.1 * jumpDelta, 1, 0, 0);
    let actualViewMatrix = invert4(inv2);

    const viewProj = multiply4(projectionMatrix, actualViewMatrix);
    toolWorker.postMessage({ view: viewProj });

    const currentFps = 1000 / (now - lastFrame) || 0;
    avgFps = (isFinite(avgFps) && avgFps) * 0.9 + currentFps * 0.1;

    if (vertexCount > 0) {
      // document.getElementById("spinner").style.display = "none";
      gl.uniformMatrix4fv(u_view, false, actualViewMatrix);
      gl.uniform1f(u_time, Math.sin(Date.now() / 1000) / 2 + 1 / 2);

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArraysInstanced(gl.TRIANGLE_FAN, 0, 4, vertexCount);
    } else {
      gl.clear(gl.COLOR_BUFFER_BIT);
      // document.getElementById("spinner").style.display = "";
      start = Date.now() + 2000;
    }
    const progress = (100 * vertexCount) / (splatData.length / rowLength);
    if (progress < 100) {
      document.getElementById("progress").style.width = progress + "%";
    } else {
      document.getElementById("progress").style.display = "none";
    }
    fps.innerText = Math.round(avgFps) + " fps";
    lastFrame = now;
    requestAnimationFrame(frame);
  };

  frame();

  const selectFile = (file) => {
    const fr = new FileReader();
    if (/\.json$/i.test(file.name)) {
      fr.onload = () => {
        cameras = JSON.parse(fr.result);
        viewMatrix = getViewMatrix(cameras[0]);
        projectionMatrix = getProjectionMatrix(camera.fx / downsample, camera.fy / downsample, canvas.width, canvas.height);
        gl.uniformMatrix4fv(u_projection, false, projectionMatrix);

        console.log("Loaded Cameras");
      };
      fr.readAsText(file);
    } else {
      stopLoading = true;
      fr.onload = () => {
        splatData = new Uint8Array(fr.result);
        console.log("Loaded", Math.floor(splatData.length / rowLength));

        if (splatData[0] == 112 && splatData[1] == 108 && splatData[2] == 121 && splatData[3] == 10) {
          // ply file magic header means it should be handled differently
          toolWorker.postMessage({ ply: splatData.buffer });
        } else if (splatData[0] == 75 && splatData[1] == 103) {
          // splatv file
          readChunks(new Response(splatData).body.getReader(), [{ size: 8, type: "magic" }], chunkHandler).then(() => {
            currentCameraIndex = 0;
            camera = cameras[currentCameraIndex];
            viewMatrix = getViewMatrix(camera);
          });
        } else {
          alert("Unsupported file format!");
        }
      };
      fr.readAsArrayBuffer(file);
    }
  };

  window.addEventListener("hashchange", (e) => {
    try {
      viewMatrix = JSON.parse(decodeURIComponent(location.hash.slice(1)));
      carousel = false;
    } catch (err) { }
  });

  const preventDefault = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  document.addEventListener("dragenter", preventDefault);
  document.addEventListener("dragover", preventDefault);
  document.addEventListener("dragleave", preventDefault);
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    selectFile(e.dataTransfer.files[0]);
  });

  let lastVertexCount = -1;
  const chunkHandler = (chunk, buffer, remaining, chunks) => {
    if (!remaining && chunk.type === "magic") {
      let intView = new Uint32Array(buffer);
      if (intView[0] !== 0x674b) throw new Error("This does not look like a splatv file");
      chunks.push({ size: intView[1], type: "chunks" });
    } else if (!remaining && chunk.type === "chunks") {
      for (let chunk of JSON.parse(new TextDecoder("utf-8").decode(buffer))) {
        chunks.push(chunk);
        if (chunk.type === "splat") {
          cameras = chunk.cameras;
          camera = chunk.cameras[0];
          resize();
        }
      }
    } else if (chunk.type === "splat") {
      if (vertexCount > lastVertexCount || remaining === 0) {
        lastVertexCount = vertexCount;
        toolWorker.postMessage({ texture: new Float32Array(buffer), remaining: remaining });
        console.log("splat", remaining);

        const texdata = new Uint32Array(buffer);
        // console.log(texdata);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, chunk.texwidth, chunk.texheight, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, texdata);
      }
    } else if (!remaining) {
      console.log("chunk", chunk, buffer);
    }
  };

  const baseUrl = params.get('meta') ? params.get('meta') : 'http://10.76.1.68:8080/fragmented/h264/stepin/';

  document.getElementById("message").innerText = 'requesting metadata...';

  // not using try: since if this request fails, the player should terminate
  let req = await fetch(new URL('meta.json', baseUrl))
  if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);
  gsvMeta = await req.json()
  gsvMeta.frameDuration = 1 / (gsvMeta.GOP + gsvMeta.overlap);
  console.info({ gsvMeta })

  keyframes = [];
  for (let index = gsvMeta.begin_index; index < gsvMeta.duration - gsvMeta.overlap; index += gsvMeta.GOP) {
    keyframes.push(padZeroStart(index.toString()));
  }
  manager.setTotalGroups(keyframes.length);

  req = await fetch(new URL('cameras.json', baseUrl))
  if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);
  const cameraData = await req.json()
  // cameras = cameraData;
  // camera = cameraData[0];

  // video and canvas setting
  const highxyzCanvas = document.getElementById('highxyzCanvas');
  highxyzCanvas.width = gsvMeta.image[0];
  highxyzCanvas.height = gsvMeta.image[0]
  const lowxyzCanvas = document.getElementById('lowxyzCanvas');
  lowxyzCanvas.width = gsvMeta.image[0];
  lowxyzCanvas.height = gsvMeta.image[0]
  const rotCanvas = document.getElementById('rotCanvas');
  rotCanvas.width = gsvMeta.image[0];
  rotCanvas.height = gsvMeta.image[0]

  await manager.blockUntilAllReady();
  // current time
  console.log('current time', new Date().toLocaleTimeString());
  plyWorker.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0] });
  downloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0], type: FTYPES.highxyz });
  downloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0], type: FTYPES.lowxyz });
  downloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0], type: FTYPES.rot });
  cbdownloader.postMessage({ baseUrl: baseUrl, keyframe: keyframes[0] });


  // const url = params.get("url") ? new URL(params.get("url"), "https://huggingface.co/cakewalk/splat-data/resolve/main/") : "model.splatv";
  // req = await fetch(url, { mode: "cors", credentials: "omit" });
  // if (req.status != 200) throw new Error(req.status + " Unable to load " + req.url);

  // await readChunks(req.body.getReader(), [{ size: 8, type: "magic" }], chunkHandler);
}

main().catch((err) => {
  document.getElementById("message").innerText = err.toString();
});

