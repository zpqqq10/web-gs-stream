export const FTYPES = {
    ply: 1,
    highxyz: 2,
    lowxyz: 3,
    rot: 4,
    cb: 5
};

// for memory alignment
export const BYTES_U8 = 1;
export const BYTES_F32 = 4;
export const BYTES_U32 = 4;
export const BYTES_U64 = 8;
export const BYTES_VEC4 = BYTES_F32 * 4;
export const BYTES_MAT4 = BYTES_F32 * 16;

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

export function setTexture(gl, texture, texData, texWidth, texHeight, index, channels = '32rgba') {
    // activate before binding
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_S,
        gl.CLAMP_TO_EDGE,
    );
    gl.texParameteri(
        gl.TEXTURE_2D,
        gl.TEXTURE_WRAP_T,
        gl.CLAMP_TO_EDGE,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    if (channels == '32rgbaui') {
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA32UI,
            texWidth,
            texHeight,
            0,
            gl.RGBA_INTEGER,
            gl.UNSIGNED_INT,
            texData,
        );
    } else if (channels == '32rgbui') {
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGB32UI,
            texWidth,
            texHeight,
            0,
            gl.RGB_INTEGER,
            gl.UNSIGNED_INT,
            texData,
        );
    } else if (channels == '32rui') {
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R32UI,
            texWidth,
            texHeight,
            0,
            gl.RED_INTEGER,
            gl.UNSIGNED_INT,
            texData,
        );
    } else if (channels == '8rgbui') {
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGB8UI,
            texWidth,
            texHeight,
            0,
            gl.RGB_INTEGER,
            gl.UNSIGNED_BYTE,
            texData,
        );
    } else if (channels == '8rgbaui') {
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA8UI,
            texWidth,
            texHeight,
            0,
            gl.RGBA_INTEGER,
            gl.UNSIGNED_BYTE,
            texData,
        );
    } else if (channels == '8rui') {
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.R8UI,
            texWidth,
            texHeight,
            0,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            texData,
        );
    } else if (channels == '16rgui') {
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RG16UI,
            texWidth,
            texHeight,
            0,
            gl.RG_INTEGER,
            gl.UNSIGNED_SHORT,
            texData,
        );
    } else {
        throw new Error('unsupported channels');
    }
    // gl.activeTexture(gl.TEXTURE0);
    // gl.bindTexture(gl.TEXTURE_2D, texture);
}

export function assertHasInjectedShader(clazz) {
    if (!clazz.SHADER_CODE || clazz.SHADER_CODE.length == 0) {
        throw new Error(`${clazz.name} has .SHADER_CODE undefined.`);
    }
}

export const getItemsPerThread = (items, threads) => {
    return Math.ceil(items / threads);
}

export function createGPUBuffer(
    device,
    label,
    // macro
    usage,
    // array
    data
) {
    const gpuBuffer = device.createBuffer({
        label,
        size: data.byteLength,
        usage,
    });
    //? or device.queue.writeBuffer(gpuBuffer, 0, data.buffer, 0);?
    device.queue.writeBuffer(gpuBuffer, 0, data, 0);
    return gpuBuffer;
}

export function writeMatrixToGPUBuffer(
    device,
    gpuBuffer,
    offsetBytes,
    data
) {
    // does not check type here
    // the caller should check the data type
    //? in fact no need to use .buffer? 
    device.queue.writeBuffer(gpuBuffer, offsetBytes, data.buffer, 0);
}

/**
 * In WGSL there is something called overrides:
 *  - https://www.w3.org/TR/WGSL/#override-declaration
 *  - https://webgpufundamentals.org/webgpu/lessons/webgpu-constants.html
 * Would have been better than text replace. But neither works
 * with language servers in text editors, so might as well text replace.
 */
export function applyShaderTextReplace(
    text,
    // [string]: string dict
    overrides
) {
    let code = text;
    overrides = overrides || {};
    Object.entries(overrides).forEach(([k, v]) => {
        code = code.replaceAll(k, v);
    });
    return code;
}

// to help webgpu debug
export function createErrorSystem(device) {
    const ERROR_SCOPES = [
        'internal',
        'out-of-memory',
        'validation',
    ];
    const ERROR_SCOPES_REV = ERROR_SCOPES.toReversed();

    let currentScopeName = '-';

    return {
        startErrorScope,
        reportErrorScopeAsync,
    };

    function startErrorScope(scopeName) {
        currentScopeName = scopeName;
        ERROR_SCOPES.forEach((sc) => device.pushErrorScope(sc));
    }

    // cb: call back function
    async function reportErrorScopeAsync(cb) {
        let lastError = undefined;

        for (const name of ERROR_SCOPES_REV) {
            const err = await device.popErrorScope();
            if (err) {
                const msg = `WebGPU error [${currentScopeName}][${name}]: ${err.message}`;
                lastError = msg;
                if (cb) {
                    cb(msg);
                } else {
                    console.error(msg);
                }
            }
        }

        return lastError;
    }
}