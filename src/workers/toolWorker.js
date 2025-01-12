import { packHalf2x16 } from "../utils/mathUtils.js";

// the newest count, up to date
let vertexCount2Date = 0;
let viewProj;
let lastProj = [];
let depthIndex = new Uint32Array();
let lastVertexCount = 0;

// we only need one texdata here
let positions;
// total number of gaussians
let total;
// total number of codebook indices
let totalCB;
let sortRunning;

// sort the gaussians according to depth
function runSort(viewProj) {
    if (!positions) return;
    // const f_buffer = new Float32Array(buffer);
    if (lastVertexCount == vertexCount2Date) {
        let dist = Math.hypot(...[2, 6, 10].map((k) => lastProj[k] - viewProj[k]));
        if (dist < 0.01) return;
    } else {
        lastVertexCount = vertexCount2Date;
    }

    // console.time("sort");
    // not cosider visibility here, since sorting is relevant to camera but not time
    let maxDepth = -Infinity;
    let minDepth = Infinity;
    let sizeList = new Int32Array(vertexCount2Date);
    for (let i = 0; i < vertexCount2Date; i++) {
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
    for (let i = 0; i < vertexCount2Date; i++) {
        sizeList[i] = ((sizeList[i] - minDepth) * depthInv) | 0;
        counts0[sizeList[i]]++;
    }
    let starts0 = new Uint32Array(128 * 128);
    for (let i = 1; i < 128 * 128; i++) starts0[i] = starts0[i - 1] + counts0[i - 1];
    depthIndex = new Uint32Array(vertexCount2Date);
    for (let i = 0; i < vertexCount2Date; i++) depthIndex[starts0[sizeList[i]]++] = i;

    // console.timeEnd("sort");
    lastProj = viewProj;
    postMessage({ depthIndex, viewProj, vertexCount: vertexCount2Date }, [depthIndex.buffer]);
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

// process the buffer containing a ply
function processPlyBuffer(inputBuffer, extent, groupIdx, texdata) {
    const ubuf = new Uint8Array(inputBuffer);
    const cbOffset = (groupIdx == -1) ? 0 : (2048 * groupIdx + 1024);
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

    var texwidth = 1024 * 3; // Set to your desired width
    // this 3 is determined by how many 32-bit values are used below
    var texheight = Math.ceil((3 * total) / texwidth); // Set to your desired height
    if (texdata.byteLength == 0) {
        texdata = new Uint32Array(texwidth * texheight * 3); // 3 components per pixel (RGB)
        positions = new Float32Array(total * 3);
    }
    // compress all into 8 32-bit numbers
    var texdata_c = new Uint8ClampedArray(texdata.buffer);
    // to store the frame index, uint16
    var texdata_t = new Uint16Array(texdata.buffer);
    var texdata_f = new Float32Array(texdata.buffer);
    // console.log(vertexCount2Date, lastVertexCount, lastVertexCount == vertexCount2Date);
    console.time("build texture");
    for (let j = 0; j < vertexCount; j++) {
        row = j;
        // with offset
        let joffset = j + lastVertexCount;

        // first 3 32-bit are used for XYZ
        positions[3 * joffset + 0] = attrs.x;
        positions[3 * joffset + 1] = attrs.y;
        positions[3 * joffset + 2] = attrs.z;

        texdata_f[9 * joffset + 0] = attrs.x;
        texdata_f[9 * joffset + 1] = attrs.y;
        texdata_f[9 * joffset + 2] = attrs.z;
        texdata_t[2 * (9 * joffset + 3) + 0] = attrs.ins;
        texdata_t[2 * (9 * joffset + 3) + 1] = attrs.outs;

        // let scale = [
        //     (attrs.scale_0 / 4095) * extent,
        //     (attrs.scale_1 / 4095) * extent,
        //     (attrs.scale_2 / 4905) * extent];

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

        // scale
        // texdata[9 * joffset + 4] = packHalf2x16(scale[0], scale[1]);
        // texdata[9 * joffset + 5] = packHalf2x16(scale[2], 0);
        texdata[9 * joffset + 4] = (attrs.scale_0 | (attrs.scale_1 << 16)) >>> 0;
        texdata[9 * joffset + 5] = (attrs.scale_2 | 0) >>> 0;

        // rotation
        texdata_c[4 * (9 * joffset + 6) + 0] = attrs.rot_0;
        texdata_c[4 * (9 * joffset + 6) + 1] = attrs.rot_1;
        texdata_c[4 * (9 * joffset + 6) + 2] = attrs.rot_2;
        texdata_c[4 * (9 * joffset + 6) + 3] = attrs.rot_3;

        // r, g, b, a/opacity
        // the last 32-bit are used for RGBA (4 8-bit)
        texdata_c[4 * (9 * joffset + 7) + 0] = attrs.f_dc_0;
        texdata_c[4 * (9 * joffset + 7) + 1] = attrs.f_dc_1;
        texdata_c[4 * (9 * joffset + 7) + 2] = attrs.f_dc_2;
        texdata_c[4 * (9 * joffset + 7) + 3] = attrs.opacity;
        texdata[9 * joffset + 8] = attrs.rest_idx + cbOffset;

        // for vanilla 3dgs
        // const SH_C0 = 0.28209479177387814;
        // texdata_c[4 * (8 * j + 7) + 0] = (0.5 + SH_C0 * attrs.f_dc_0) * 255;
        // texdata_c[4 * (8 * j + 7) + 1] = (0.5 + SH_C0 * attrs.f_dc_1) * 255;
        // texdata_c[4 * (8 * j + 7) + 2] = (0.5 + SH_C0 * attrs.f_dc_2) * 255;
        // texdata_c[4 * (8 * j + 7) + 3] = (1 / (1 + Math.exp(-attrs.opacity))) * 255;

    }
    console.timeEnd("build texture");
    postMessage({ texdata, texwidth, texheight }, [texdata.buffer]);
    return vertexCount + lastVertexCount;
}

// process the buffer containing a codebook
function processCodebook(inputBuffer, groupIdx, cbtexdata) {
    const ubuf = new Uint16Array(inputBuffer);
    const count = (groupIdx == -1) ? 1024 : 2048;
    const begin_offset = (groupIdx == -1) ? 0 : (2048 * groupIdx + 1024);

    var texwidth = 1024 * 8; // Set to your desired width
    // this 8 is determined by how many 32-bit values are used below
    var texheight = Math.ceil((8 * totalCB) / texwidth); // Set to your desired height
    if (cbtexdata.byteLength == 0) {
        cbtexdata = new Uint32Array(texwidth * texheight * 3); // 3 components per pixel (RGB)
    }
    console.time("build cb texture");
    for (let j = 0; j < count; j++) {
        var joffset = j + begin_offset;
        cbtexdata[24 * joffset + 0] = (ubuf[45 * j + 0] | (ubuf[45 * j + 1] << 16)) >>> 0;
        cbtexdata[24 * joffset + 1] = (ubuf[45 * j + 2] | (ubuf[45 * j + 3] << 16)) >>> 0;
        cbtexdata[24 * joffset + 2] = (ubuf[45 * j + 4] | (ubuf[45 * j + 5] << 16)) >>> 0;
        cbtexdata[24 * joffset + 3] = (ubuf[45 * j + 6] | (ubuf[45 * j + 7] << 16)) >>> 0;
        cbtexdata[24 * joffset + 4] = (ubuf[45 * j + 8] | (ubuf[45 * j + 9] << 16)) >>> 0;
        cbtexdata[24 * joffset + 5] = (ubuf[45 * j + 10] | (ubuf[45 * j + 11] << 16)) >>> 0;
        cbtexdata[24 * joffset + 6] = (ubuf[45 * j + 12] | (ubuf[45 * j + 13] << 16)) >>> 0;
        cbtexdata[24 * joffset + 7] = (ubuf[45 * j + 14] | (ubuf[45 * j + 15] << 16)) >>> 0;
        cbtexdata[24 * joffset + 8] = (ubuf[45 * j + 16] | (ubuf[45 * j + 17] << 16)) >>> 0;
        cbtexdata[24 * joffset + 9] = (ubuf[45 * j + 18] | (ubuf[45 * j + 19] << 16)) >>> 0;
        cbtexdata[24 * joffset + 10] = (ubuf[45 * j + 20] | (ubuf[45 * j + 21] << 16)) >>> 0;
        cbtexdata[24 * joffset + 11] = (ubuf[45 * j + 22] | (ubuf[45 * j + 23] << 16)) >>> 0;
        cbtexdata[24 * joffset + 12] = (ubuf[45 * j + 24] | (ubuf[45 * j + 25] << 16)) >>> 0;
        cbtexdata[24 * joffset + 13] = (ubuf[45 * j + 26] | (ubuf[45 * j + 27] << 16)) >>> 0;
        cbtexdata[24 * joffset + 14] = (ubuf[45 * j + 28] | (ubuf[45 * j + 29] << 16)) >>> 0;
        cbtexdata[24 * joffset + 15] = (ubuf[45 * j + 30] | (ubuf[45 * j + 31] << 16)) >>> 0;
        cbtexdata[24 * joffset + 16] = (ubuf[45 * j + 32] | (ubuf[45 * j + 33] << 16)) >>> 0;
        cbtexdata[24 * joffset + 17] = (ubuf[45 * j + 34] | (ubuf[45 * j + 35] << 16)) >>> 0;
        cbtexdata[24 * joffset + 18] = (ubuf[45 * j + 36] | (ubuf[45 * j + 37] << 16)) >>> 0;
        cbtexdata[24 * joffset + 19] = (ubuf[45 * j + 38] | (ubuf[45 * j + 39] << 16)) >>> 0;
        cbtexdata[24 * joffset + 20] = (ubuf[45 * j + 40] | (ubuf[45 * j + 41] << 16)) >>> 0;
        cbtexdata[24 * joffset + 21] = (ubuf[45 * j + 42] | (ubuf[45 * j + 43] << 16)) >>> 0;
        cbtexdata[24 * joffset + 22] = (ubuf[45 * j + 44] | 0) >>> 0;
        // leave 1.5 32-bit for future use

    }
    console.timeEnd("build cb texture");
    postMessage({ cbtexdata, texwidth, texheight }, [cbtexdata.buffer]);
}

onmessage = (e) => {
    if (e.data.view) {
        viewProj = e.data.view;
        throttledSort();
    } else if (e.data.ply) {
        if (e.data.total > 0) {
            total = e.data.total;
        }
        // uint8array here
        vertexCount2Date = processPlyBuffer(e.data.ply.buffer, e.data.extent, e.data.groupIdx, e.data.tex);
    } else if (e.data.cb) {
        if (e.data.total > 0) {
            totalCB = e.data.total;
        }
        processCodebook(e.data.cb, e.data.groupIdx, e.data.tex);
    }
};