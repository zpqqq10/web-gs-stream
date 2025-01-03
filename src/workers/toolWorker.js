import { packHalf2x16 } from "../utils/mathUtils.js";

let vertexCount = 0;
let viewProj;
let lastProj = [];
let depthIndex = new Uint32Array();
let lastVertexCount = 0;
let positions;

const PISQRT = 1.77245385
const EXTENT = 5.7177

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

    // This is a x-bit single-pass counting sort
    // bins here can influence sorting efficiency
    let depthInv = (128 * 128 - 1) / (maxDepth - minDepth);
    let counts0 = new Uint32Array(128 * 128);
    for (let i = 0; i < vertexCount; i++) {
        sizeList[i] = ((sizeList[i] - minDepth) * depthInv) | 0;
        counts0[sizeList[i]]++;
    }
    let starts0 = new Uint32Array(128 * 128);
    for (let i = 1; i < 128 * 128; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
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
    // 10KB ought to be enough for a header...
    const header = new TextDecoder().decode(ubuf.slice(0, 1024 * 10));
    const header_end = "end_header\n";
    const header_end_index = header.indexOf(header_end);
    if (header_end_index < 0)
        throw new Error("Unable to read .ply file header");
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
    // console.log("Bytes per row", row_offset, types, offsets);

    let dataView = new DataView(
        inputBuffer,
        header_end_index + header_end.length,
    );
    let row = 0;
    const attrs = new Proxy(
        {},
        {
            get(target, prop) {
                if (!types[prop]) throw new Error(prop + " not found");
                return dataView[types[prop]](
                    row * row_offset + offsets[prop],
                    true,
                );
            },
        },
    );

    var texwidth = 1024 * 2; // Set to your desired width
    var texheight = Math.ceil((2 * vertexCount) / texwidth); // Set to your desired height
    // compress all into 7 32-bit numbers
    var texdata = new Uint32Array(texwidth * texheight * 4); // 4 components per pixel (RGBA)
    var texdata_c = new Uint8ClampedArray(texdata.buffer);
    var texdata_f = new Float32Array(texdata.buffer);
    positions = new Float32Array(vertexCount * 3);
    console.time("build texture");
    for (let j = 0; j < vertexCount; j++) {
        row = j;

        // first 3 32-bit are used for XYZ
        texdata_f[8 * j + 0] = attrs.x;
        texdata_f[8 * j + 1] = attrs.y;
        texdata_f[8 * j + 2] = attrs.z;
        positions[3 * j + 0] = attrs.x;
        positions[3 * j + 1] = attrs.y;
        positions[3 * j + 2] = attrs.z;

        let scale = [
            (attrs.scale_0 / 4095) * EXTENT,
            (attrs.scale_1 / 4095) * EXTENT,
            (attrs.scale_2 / 4905) * EXTENT];
        let rot = [
            (attrs.rot_0) / 255 * 2 - 1,
            (attrs.rot_1) / 255 * 2 - 1,
            (attrs.rot_2) / 255 * 2 - 1,
            (attrs.rot_3) / 255 * 2 - 1,
        ];

        // for vanilla 3dgs
        // const qlen = Math.sqrt(
        //     attrs.rot_0 ** 2 +
        //     attrs.rot_1 ** 2 +
        //     attrs.rot_2 ** 2 +
        //     attrs.rot_3 ** 2,
        // );
        // let scale = [
        //     Math.exp(attrs.scale_0),
        //     Math.exp(attrs.scale_1),
        //     Math.exp(attrs.scale_2)];
        // let rot = [
        //     attrs.rot_0 / qlen,
        //     attrs.rot_1 / qlen,
        //     attrs.rot_2 / qlen,
        //     attrs.rot_3 / qlen,
        // ];

        // Compute the matrix product of S and R (M = S * R)
        const M = [
            1.0 - 2.0 * (rot[2] * rot[2] + rot[3] * rot[3]),
            2.0 * (rot[1] * rot[2] + rot[0] * rot[3]),
            2.0 * (rot[1] * rot[3] - rot[0] * rot[2]),

            2.0 * (rot[1] * rot[2] - rot[0] * rot[3]),
            1.0 - 2.0 * (rot[1] * rot[1] + rot[3] * rot[3]),
            2.0 * (rot[2] * rot[3] + rot[0] * rot[1]),

            2.0 * (rot[1] * rot[3] + rot[0] * rot[2]),
            2.0 * (rot[2] * rot[3] - rot[0] * rot[1]),
            1.0 - 2.0 * (rot[1] * rot[1] + rot[2] * rot[2]),
        ].map((k, i) => k * scale[Math.floor(i / 3)]);

        // 3D covariance matrix
        const sigma = [
            M[0] * M[0] + M[3] * M[3] + M[6] * M[6],
            M[0] * M[1] + M[3] * M[4] + M[6] * M[7],
            M[0] * M[2] + M[3] * M[5] + M[6] * M[8],
            M[1] * M[1] + M[4] * M[4] + M[7] * M[7],
            M[1] * M[2] + M[4] * M[5] + M[7] * M[8],
            M[2] * M[2] + M[5] * M[5] + M[8] * M[8],
        ];

        texdata[8 * j + 4] = packHalf2x16(4 * sigma[0], 4 * sigma[1]);
        texdata[8 * j + 5] = packHalf2x16(4 * sigma[2], 4 * sigma[3]);
        texdata[8 * j + 6] = packHalf2x16(4 * sigma[4], 4 * sigma[5]);

        // r, g, b, a/opacity
        // the last 32-bit are used for RGBA (4 8-bit)
        texdata_c[4 * (8 * j + 7) + 0] = attrs.f_dc_0;
        texdata_c[4 * (8 * j + 7) + 1] = attrs.f_dc_1;
        texdata_c[4 * (8 * j + 7) + 2] = attrs.f_dc_2;
        // TODO 这里要不要activate啊？
        texdata_c[4 * (8 * j + 7) + 3] = attrs.opacity;

        // for vanilla 3dgs
        // const SH_C0 = 0.28209479177387814;
        // texdata_c[4 * (8 * j + 7) + 0] = (0.5 + SH_C0 * attrs.f_dc_0) * 255;
        // texdata_c[4 * (8 * j + 7) + 1] = (0.5 + SH_C0 * attrs.f_dc_1) * 255;
        // texdata_c[4 * (8 * j + 7) + 2] = (0.5 + SH_C0 * attrs.f_dc_2) * 255;
        // texdata_c[4 * (8 * j + 7) + 3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;

    }
    console.timeEnd("build texture");
    postMessage({ texdata, texwidth, texheight }, [texdata.buffer]);
    return vertexCount;
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
        // uint8array here
        vertexCount = processPlyBuffer(e.data.ply.buffer);
    }
};