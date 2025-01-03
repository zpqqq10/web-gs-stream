export const FTYPES = {
    ply: 1,
    highxyz: 2,
    lowxyz: 3,
    rot: 4, 
    cb: 5
};

export const preventDefault = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

export function attachShaders(gl, vertexShaderSource, fragmentShaderSource) {
    const vertexShader = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vertexShader, vertexShaderSource);
    gl.compileShader(vertexShader);
    if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(vertexShader));

    const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fragmentShader, fragmentShaderSource);
    gl.compileShader(fragmentShader);
    if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(fragmentShader));

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.useProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(program));
    return program;
}

export async function readChunks(reader, chunks, handleChunk) {
    let chunk = chunks.shift();
    let buffer = new Uint8Array(chunk.size);
    let offset = 0;
    while (chunk) {
        let { done, value } = await reader.read();
        if (done) break;
        while (value.length + offset >= chunk.size) {
            buffer.set(value.subarray(0, chunk.size - offset), offset);
            value = value.subarray(chunk.size - offset);
            handleChunk(chunk, buffer.buffer, 0, chunks);
            chunk = chunks.shift();
            if (!chunk) break;
            buffer = new Uint8Array(chunk.size);
            offset = 0;
        }
        if (!chunk) break;
        buffer.set(value, offset);
        offset += value.length;
        handleChunk(chunk, buffer.buffer, buffer.byteLength - offset, chunks);
    }
    if (chunk) handleChunk(chunk, buffer.buffer, 0, chunks);
}

export async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function padZeroStart(str, n = 6) {
    return (Array(n).join(0) + str).slice(-n);
}