import {
    applyShaderTextReplace,
    assertHasInjectedShader,
    getItemsPerThread,
    writeMatrixToGPUBuffer,
    BYTES_VEC4,
    BYTES_MAT4,
    BYTES_U32,
    createGPUBuffer
} from './utils.js';
import { RadixSortKernel } from './WebGPU-Radix-Sort/index.js';

export class DepthCalculator {
    // save the name as a static member
    static NAME = DepthCalculator.name;
    static NUM_THREADS = 64;
    static SHADER_CODE = '';

    // device: GPUDevice,
    // distancesBuffer: GPUBuffer,
    // indicesBuffer: GPUBuffer
    // total_gs: int
    constructor(
        device,
        // F32 buffer of size nearestPowerOf2_ceil($total_gs)
        distancesBuffer,
        // U32 buffer of size nearestPowerOf2_ceil($total_gs)
        indicesBuffer,
        // total number of gs of whole video
        total_gs
    ) {
        assertHasInjectedShader(DepthCalculator);
        const itemsPerThread = getItemsPerThread(
            total_gs,
            DepthCalculator.NUM_THREADS
        );

        this.positionBuffer = device.createBuffer({
            label: 'depth-calculator-position',
            size: BYTES_VEC4 * total_gs,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        this.viewBuffer = device.createBuffer({
            label: 'depth-calculator-uniforms',
            size: BYTES_MAT4,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });


        this.vertexCountBuffer = device.createBuffer({
            label: 'depth-calculator-vertexCount',
            size: BYTES_U32,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.pipeline = DepthCalculator.createPipeline(
            device,
            itemsPerThread
        );

        this.uniformsBindings = device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.positionBuffer },
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
                    resource: { buffer: this.viewBuffer },
                },
                {
                    binding: 4,
                    resource: { buffer: this.vertexCountBuffer },
                },
            ],
        });
    }

    static createPipeline(
        device,
        // int
        itemsPerThread
    ) {
        const code = applyShaderTextReplace(DepthCalculator.SHADER_CODE, {
            __ITEMS_PER_THREAD__: '' + itemsPerThread,
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
        const { cmdBuf, device, viewProj, profiler, currentVertexCount, positions } = ctx;

        writeMatrixToGPUBuffer(device, this.positionBuffer, 0, positions);
        const viewProjBuffer = new Float32Array(viewProj);
        writeMatrixToGPUBuffer(device, this.viewBuffer, 0, viewProjBuffer);
        const vtxCountArray = new Uint32Array([currentVertexCount]);
        writeMatrixToGPUBuffer(device, this.vertexCountBuffer, 0, vtxCountArray);

        const computePass = cmdBuf.beginComputePass({
            label: 'depth-calculator',
            timestampWrites: profiler?.createScopeGpu(DepthCalculator.NAME),
        });
        computePass.setPipeline(this.pipeline);
        computePass.setBindGroup(0, this.uniformsBindings);
        computePass.dispatchWorkgroups(DepthCalculator.NUM_THREADS);
        computePass.end();
    }

    static setShader = (text) => {
        this.SHADER_CODE = text;
    }
}


export class RadixSorter {
    static NAME = RadixSorter.name;

    constructor(
        device
    ) {
        this.device = device;
    }

    cmdSort(ctx) {
        const { cmdBuf, profiler, currentVertexCount, distancesBuffer, indicesBuffer } = ctx;
        const kernel = new RadixSortKernel({
            device: this.device,
            // depth
            keys: distancesBuffer,
            values: indicesBuffer,
            count: currentVertexCount,
            bit_count: 32,
            workgroup_size: { x: 16, y: 16 },
            check_order: true,
            local_shuffle: false,
            avoid_bank_conflicts: false,
        })

        const computePass = cmdBuf.beginComputePass({
            label: "radix-sorter",
            timestampWrites: profiler?.createScopeGpu(RadixSorter.NAME),
        });
        kernel.dispatch(computePass);
        computePass.end();

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
                    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
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

