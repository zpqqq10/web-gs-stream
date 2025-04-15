import {
    applyShaderTextReplace,
    assertHasInjectedShader,
    getItemsPerThread,
    writeMatrixToGPUBuffer,
    BYTES_VEC4,
    BYTES_MAT4
} from './utils.ts';

export class CalcDepthsPass {
    // save the name as a static member
    static NAME = CalcDepthsPass.name;
    static NUM_THREADS = 64;
    static SHADER_CODE = '';

    // device: GPUDevice,
    // splatPositions: GPUBuffer,
    // distancesBuffer: GPUBuffer,
    // indicesBuffer: GPUBuffer
    constructor(
        device,
        splatPositions,
        // F32 buffer of size nearestPowerOf2_ceil($vertexCount)
        distancesBuffer,
        // U32 buffer of size nearestPowerOf2_ceil($vertexCount)
        indicesBuffer
    ) {
        assertHasInjectedShader(CalcDepthsPass);
        const vertexCount = splatPositions.size / BYTES_VEC4;
        const itemsPerThread = getItemsPerThread(
            vertexCount,
            CalcDepthsPass.NUM_THREADS
        );

        this.uniformsBuffer = device.createBuffer({
            label: 'CalcDepthsPass-uniforms',
            size: BYTES_MAT4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.pipeline = CalcDepthsPass.createPipeline(
            device,
            vertexCount,
            itemsPerThread
        );

        this.uniformsBindings = device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: splatPositions },
                },
                {
                    binding: 1,
                    resource: { buffer: distancesBuffer },
                },
                {
                    binding: 2,
                    resource: { buffer: indicesBuffer },
                },
                {
                    binding: 3,
                    resource: { buffer: this.uniformsBuffer },
                },
            ],
        });
    }

    static createPipeline(
        device,
        // int
        vertexCount,
        // int
        itemsPerThread
    ) {
        const code = applyShaderTextReplace(CalcDepthsPass.SHADER_CODE, {
            __ITEMS_PER_THREAD__: '' + itemsPerThread,
            __SPLAT_COUNT__: '' + vertexCount,
        });
        const shaderModule = device.createShaderModule({ code });
        return device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: shaderModule,
                entryPoint: 'main',
            },
        });
    }

    cmdCalcDepths(ctx) {
        const { cmdBuf, device, mvpMatrix, profiler } = ctx;

        writeMatrixToGPUBuffer(device, this.uniformsBuffer, 0, mvpMatrix);

        const computePass = cmdBuf.beginComputePass({
            label: 'calc-depths-pass',
            timestampWrites: profiler?.createScopeGpu(CalcDepthsPass.NAME),
        });
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, this.uniformsBindings);
        computePass.dispatchWorkgroups(CalcDepthsPass.NUM_THREADS);
        computePass.end();
    }

    static setShader = (text) => {
        this.SHADER_CODE = text;
    }
}

// obtain corresponding depths at first
// then sort
/** https://en.wikipedia.org/wiki/Bitonic_sorter */
export class BitonicSorter {
    static NAME = BitonicSorter.name;
    static SHADER_CODE = '';
    static NUM_THREADS = 8192;
    static WORKGROUP_SIZE = 128;

    constructor(
        device,
        // 2^n rounding of number of gs
        itemCountCeilPwr2,
        // GPUBuffer
        indicesBuffer,
        // GPUBuffer
        distancesBuffer
    ) {
        assertHasInjectedShader(BitonicSorter);
        const itemsPerThread = getItemsPerThread(
            itemCountCeilPwr2,
            BitonicSorter.NUM_THREADS
        );

        this.pipeline = BitonicSorter.createPipeline(device, itemsPerThread);

        this.gpuUniformBuffers = BitonicSorter.createUniformBuffers(
            device,
            itemCountCeilPwr2
        );
        console.log(
            `Bitonic sort will have ${this.gpuUniformBuffers.length} passes.`
        );
        this.gpuUniformBuffersBindGroups = this.gpuUniformBuffers.map(
            (uniformBuffer) =>
                BitonicSorter.createBindGroup(
                    device,
                    this.pipeline,
                    indicesBuffer,
                    distancesBuffer,
                    uniformBuffer
                )
        );
    }

    static createPipeline(
        device,
        // int
        itemsPerThread) {
        const code = applyShaderTextReplace(BitonicSorter.SHADER_CODE, {
            __ITEMS_PER_THREAD__: '' + itemsPerThread,
            __WORKGROUP_SIZE__: '' + BitonicSorter.WORKGROUP_SIZE,
        });
        const shaderModule = device.createShaderModule({ code });
        return device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: shaderModule,
                entryPoint: 'main',
            },
        });
    }

    cmdSort(ctx) {
        const { cmdBuf, profiler } = ctx;


        this.gpuUniformBuffersBindGroups.forEach((uniformBindGroup) => {
            const computePass = cmdBuf.beginComputePass({
                timestampWrites: profiler?.createScopeGpu(BitonicSorter.NAME),
            });
            computePass.setPipeline(this.pipeline);
            computePass.setBindGroup(0, uniformBindGroup);
            computePass.dispatchWorkgroups(
                BitonicSorter.NUM_THREADS / BitonicSorter.WORKGROUP_SIZE
            );
            computePass.end();
        });

        // this.profiler.endRegionGpu(cmdBuf, profilerScope);
    }

    /**
     * TODO inline k,j iterations into the kernel? No global barriers means fancy with workgroup barriers?
     *
     * See below for better, but not working solutions.
     * TL;DR: Uniforms have to be aligned to 256 bytes, we only have BYTES_U32*2=8.
     * That would be a massive waste of space.
     */
    static createUniformBuffers(device, elementCount) {
        const uniformBuffers = [];

        // WIKIPEDIA: k is doubled every iteration
        for (let k = 2; k <= elementCount; k <<= 1) {
            // WIKIPEDIA: j is halved at every iteration, with truncation of fractional parts
            //
            // since JS is.. JS, i'd rather bit shift instead of divide.
            // Call me paranoid..
            for (let j = k >> 1; j > 0; j >>= 1) {
                const bufferContent = new Uint32Array([j, k]);
                // console.log('BitonicSort:', { j, k });

                const gpuBuffer = createGPUBuffer(
                    device,
                    `bitonic-sort.uniforms-buffer(k=${k},j=${j})`,
                    GPU_BUFFER_USAGE_UNIFORM,
                    bufferContent
                );
                uniformBuffers.push(gpuBuffer);
            }
        }

        return uniformBuffers;
    }

    static createBindGroup = (
        device,
        // GPUComputePipeline,
        computePipeline,
        // GPUBuffer,
        indicesBuffer,
        // GPUBuffer,
        distancesBuffer,
        // GPUBuffer
        uniformsBuffer
    ) =>
        device.createBindGroup({
            layout: computePipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: indicesBuffer },
                },
                {
                    binding: 1,
                    resource: { buffer: distancesBuffer },
                },
                {
                    binding: 2,
                    resource: { buffer: uniformsBuffer },
                },
            ],
        });

    static setShader = (text) => {
        this.SHADER_CODE = text;
    }
}

export class UnrollIndicesPass {
    static NAME = UnrollIndicesPass.name;
    static NUM_THREADS = 64;
    static SHADER_CODE = '';

    constructor(
        device,
        // GPUBuffer,
        indicesBuffer,
        // GPUBuffer,
        unrolledIndicesBuffer,
        // int
        vertexCount
    ) {
        assertHasInjectedShader(UnrollIndicesPass);
        const itemsPerThread = getItemsPerThread(
            vertexCount,
            UnrollIndicesPass.NUM_THREADS
        );

        this.pipeline = UnrollIndicesPass.createPipeline(device, itemsPerThread);

        this.uniformsBindings = device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: indicesBuffer },
                },
                {
                    binding: 1,
                    resource: { buffer: unrolledIndicesBuffer },
                },
            ],
        });
    }

    static createPipeline(device,
        // int 
        itemsPerThread) {
        const code = applyShaderTextReplace(UnrollIndicesPass.SHADER_CODE, {
            __ITEMS_PER_THREAD__: '' + itemsPerThread,
            // TODO remove this?
            __VERTICES_PER_SPLAT__: '6',
        });
        const shaderModule = device.createShaderModule({ code });
        return device.createComputePipeline({
            layout: 'auto',
            compute: {
                module: shaderModule,
                entryPoint: 'main',
            },
        });
    }

    cmdUnrollIndices(ctx) {
        const { cmdBuf, profiler } = ctx;

        const computePass = cmdBuf.beginComputePass({
            label: 'unroll-indices-pass',
            timestampWrites: profiler?.createScopeGpu(UnrollIndicesPass.NAME),
        });
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, this.uniformsBindings);
        computePass.dispatchWorkgroups(UnrollIndicesPass.NUM_THREADS);
        computePass.end();
    }

    static setShader = (text) => {
        this.SHADER_CODE = text;
    }
}

