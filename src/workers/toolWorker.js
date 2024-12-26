let vertexCount = 0;
let viewProj;
let lastProj = [];
let depthIndex = new Uint32Array();
let lastVertexCount = 0;
let positions;

var _floatView = new Float32Array(1);
var _int32View = new Int32Array(_floatView.buffer);

// 将浮点数转换为半精度浮点数
function floatToHalf(float) {
    _floatView[0] = float;
    var f = _int32View[0];
    var sign = (f >> 31) & 0x0001;
    var exp = (f >> 23) & 0x00ff;
    var frac = f & 0x007fffff;
    var newExp;
    if (exp == 0) {
        newExp = 0;
    } else if (exp < 113) {
        newExp = 0;
        frac |= 0x00800000;
        frac = frac >> (113 - exp);
        if (frac & 0x01000000) {
            newExp = 1;
            frac = 0;
        }
    } else if (exp < 142) {
        newExp = exp - 112;
    } else {
        newExp = 31;
        frac = 0;
    }
    return (sign << 15) | (newExp << 10) | (frac >> 13);
}

// 将两个半精度浮点数打包为一个32位整数
function packHalf2x16(x, y) {
    return (floatToHalf(x) | (floatToHalf(y) << 16)) >>> 0;
}

// 运行排序算法
function runSort(viewProj) {
    if (!positions) return;
    // const f_buffer = new Float32Array(buffer);
    if (lastVertexCount == vertexCount) {
        let dist = Math.hypot(...[2, 6, 10].map((k) => lastProj[k] - viewProj[k]));
        if (dist < 0.01) return;
    } else {
        lastVertexCount = vertexCount;
    }

    console.time("sort");
    let maxDepth = -Infinity;
    let minDepth = Infinity;
    let sizeList = new Int32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) {
        let depth =
            ((viewProj[2] * positions[3 * i + 0] + viewProj[6] * positions[3 * i + 1] + viewProj[10] * positions[3 * i + 2]) * 4096) | 0;
        sizeList[i] = depth;
        if (depth > maxDepth) maxDepth = depth;
        if (depth < minDepth) minDepth = depth;
    }

    // This is a 16 bit single-pass counting sort
    let depthInv = (256 * 256) / (maxDepth - minDepth);
    let counts0 = new Uint32Array(256 * 256);
    for (let i = 0; i < vertexCount; i++) {
        sizeList[i] = ((sizeList[i] - minDepth) * depthInv) | 0;
        counts0[sizeList[i]]++;
    }
    let starts0 = new Uint32Array(256 * 256);
    for (let i = 1; i < 256 * 256; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
    depthIndex = new Uint32Array(vertexCount);
    for (let i = 0; i < vertexCount; i++) depthIndex[starts0[sizeList[i]]++] = i;

    console.timeEnd("sort");

    lastProj = viewProj;
    postMessage({ depthIndex, viewProj, vertexCount }, [depthIndex.buffer]);
}

const throttledSort = () => {
    if (!sortRunning) {
        sortRunning = true;
        let lastView = viewProj;
        runSort(lastView);
        setTimeout(() => {
            sortRunning = false;
            if (lastView !== viewProj) {
                throttledSort();
            }
        }, 0);
    }
};

let sortRunning;

// 处理PLY文件缓冲区
function processPlyBuffer(inputBuffer) {
    const ubuf = new Uint8Array(inputBuffer);
    const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
    const header_end = "end_header\n";
    const header_end_index = header.indexOf(header_end);
    if (header_end_index < 0) throw new Error("Unable to read .ply file header");
    const vertexCount = parseInt(/element vertex (\d+)\n/.exec(header)[1]);
    console.log("Vertex Count", vertexCount);
    let row_offset = 0,
        offsets = {},
        types = {};
    const TYPE_MAP = {
        double: "getFloat64",
        int: "getInt32",
        uint: "getUint32",
        float: "getFloat32",
        short: "getInt16",
        ushort: "getUint16",
        uchar: "getUint8",
    };
    for (let prop of header
        .slice(0, header_end_index)
        .split("\n")
        .filter((k) => k.startsWith("property "))) {
        const [p, type, name] = prop.split(" ");
        const arrayType = TYPE_MAP[type] || "getInt8";
        types[name] = arrayType;
        offsets[name] = row_offset;
        row_offset += parseInt(arrayType.replace(/[^\d]/g, "")) / 8;
    }

    console.log("Bytes per row", row_offset, types, offsets);

    let dataView = new DataView(inputBuffer, header_end_index + header_end.length);
    let row = 0;
    const attrs = new Proxy(
        {},
        {
            get(target, prop) {
                if (!types[prop]) throw new Error(prop + " not found");
                return dataView[types[prop]](row * row_offset + offsets[prop], true);
            },
        }
    );

    console.time("calculate importance");
    let sizeList = new Float32Array(vertexCount);
    let sizeIndex = new Uint32Array(vertexCount);
    for (row = 0; row < vertexCount; row++) {
        sizeIndex[row] = row;
        if (!types["scale_0"]) continue;
        const size = Math.exp(attrs.scale_0) * Math.exp(attrs.scale_1) * Math.exp(attrs.scale_2);
        const opacity = 1 / (1 + Math.exp(-attrs.opacity));
        sizeList[row] = size * opacity;
    }
    console.timeEnd("calculate importance");

    for (let type in types) {
        let min = Infinity,
            max = -Infinity;
        for (row = 0; row < vertexCount; row++) {
            sizeIndex[row] = row;
            min = Math.min(min, attrs[type]);
            max = Math.max(max, attrs[type]);
        }
        console.log(type, min, max);
    }

    console.time("sort");
    sizeIndex.sort((b, a) => sizeList[a] - sizeList[b]);
    console.timeEnd("sort");

    const position_buffer = new Float32Array(3 * vertexCount);

    var texwidth = 1024 * 4; // Set to your desired width
    var texheight = Math.ceil((4 * vertexCount) / texwidth); // Set to your desired height
    var texdata = new Uint32Array(texwidth * texheight * 4); // 4 components per pixel (RGBA)
    var texdata_c = new Uint8Array(texdata.buffer);
    var texdata_f = new Float32Array(texdata.buffer);

    console.time("build buffer");
    for (let j = 0; j < vertexCount; j++) {
        row = sizeIndex[j];

        // x, y, z
        position_buffer[3 * j + 0] = attrs.x;
        position_buffer[3 * j + 1] = attrs.y;
        position_buffer[3 * j + 2] = attrs.z;

        texdata_f[16 * j + 0] = attrs.x;
        texdata_f[16 * j + 1] = attrs.y;
        texdata_f[16 * j + 2] = attrs.z;

        // quaternions
        texdata[16 * j + 3] = packHalf2x16(attrs.rot_0, attrs.rot_1);
        texdata[16 * j + 4] = packHalf2x16(attrs.rot_2, attrs.rot_3);

        // scale
        texdata[16 * j + 5] = packHalf2x16(Math.exp(attrs.scale_0), Math.exp(attrs.scale_1));
        texdata[16 * j + 6] = packHalf2x16(Math.exp(attrs.scale_2), 0);

        // rgb
        texdata_c[4 * (16 * j + 7) + 0] = Math.max(0, Math.min(255, attrs.f_dc_0 * 255));
        texdata_c[4 * (16 * j + 7) + 1] = Math.max(0, Math.min(255, attrs.f_dc_1 * 255));
        texdata_c[4 * (16 * j + 7) + 2] = Math.max(0, Math.min(255, attrs.f_dc_2 * 255));

        // opacity
        texdata_c[4 * (16 * j + 7) + 3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;

        // movement over time
        texdata[16 * j + 8 + 0] = packHalf2x16(attrs.motion_0, attrs.motion_1);
        texdata[16 * j + 8 + 1] = packHalf2x16(attrs.motion_2, attrs.motion_3);
        texdata[16 * j + 8 + 2] = packHalf2x16(attrs.motion_4, attrs.motion_5);
        texdata[16 * j + 8 + 3] = packHalf2x16(attrs.motion_6, attrs.motion_7);
        texdata[16 * j + 8 + 4] = packHalf2x16(attrs.motion_8, 0);

        // rotation over time
        texdata[16 * j + 8 + 5] = packHalf2x16(attrs.omega_0, attrs.omega_1);
        texdata[16 * j + 8 + 6] = packHalf2x16(attrs.omega_2, attrs.omega_3);

        // trbf temporal radial basis function parameters
        texdata[16 * j + 8 + 7] = packHalf2x16(attrs.trbf_center, Math.exp(attrs.trbf_scale));
    }
    console.timeEnd("build buffer");

    console.log("Scene Bytes", texdata.buffer.byteLength);

    postMessage({ texdata, texwidth, texheight }, [texdata.buffer]);
}

onmessage = (e) => {
    if (e.data.texture) {
        let texture = e.data.texture;
        vertexCount = Math.floor((texture.byteLength - e.data.remaining) / 4 / 16);
        positions = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
            positions[3 * i + 0] = texture[16 * i + 0];
            positions[3 * i + 1] = texture[16 * i + 1];
            positions[3 * i + 2] = texture[16 * i + 2];
        }
        throttledSort();
    } else if (e.data.vertexCount) {
        vertexCount = e.data.vertexCount;
    } else if (e.data.view) {
        viewProj = e.data.view;
        throttledSort();
    } else if (e.data.ply) {
        vertexCount = 0;
        vertexCount = processPlyBuffer(e.data.ply);
    }
};