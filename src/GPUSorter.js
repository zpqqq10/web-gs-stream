import { BYTES_F32, BYTES_U32 } from './utils/utils.js';
import { nearestPowerOf2_ceil } from './utils/mathUtils.js';
import { DepthCalculator, BitonicSorter, RadixSorter } from './utils/WGPUSort.js';

export class GPUSorter {
    constructor(device, totalGS) {
        this.itemCountCeilPwr2 = nearestPowerOf2_ceil(totalGS);

        const [indicesBuffer, distancesBuffer, depthIndexReadBuffer] = GPUSorter.createBuffers(
            device,
            this.itemCountCeilPwr2
        );
        this.indicesBuffer = indicesBuffer;
        this.distancesBuffer = distancesBuffer;
        this.depthIndexReadBuffer = depthIndexReadBuffer;

        // subpasses
        this.depthCalculator = new DepthCalculator(
            device,
            this.distancesBuffer,
            this.indicesBuffer,
            totalGS
        );
        // this.radixSorter = new RadixSorter(device);
        this.bitonicSorter = new BitonicSorter(
            device,
            this.itemCountCeilPwr2,
            this.indicesBuffer,
            this.distancesBuffer
        );

        this.sortRunning = false;
        this.lastView = null;
        this.sortedVertexCount = null;
    }

    static createBuffers(
        device,
        // int
        itemCountCeilPwr2) {
        // sequential order written in calcDepth
        // and store the output in sort
        const indicesBuffer = device.createBuffer({
            label: 'GPUSorter.indices-buffer',
            size: itemCountCeilPwr2 * BYTES_U32,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });
        const distancesBuffer = device.createBuffer({
            label: 'GPUSorter.distances-buffer',
            size: itemCountCeilPwr2 * BYTES_F32,
            usage: GPUBufferUsage.STORAGE,
        });

        // to read output
        const depthIndexReadBuffer = device.createBuffer({
            label: "GPUSorter.depth-index-read-buffer",
            size: itemCountCeilPwr2 * BYTES_U32,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
        return [indicesBuffer, distancesBuffer, depthIndexReadBuffer];
    }

    cmdSortByDepth(ctx) {
        if (!this.sortRunning) {
            const { device, cmdBuf, viewProj, currentVertexCount } = ctx;

            this.sortRunning = true;
            if (currentVertexCount == this.sortedVertexCount) {
                let dist = Math.hypot(...[2, 6, 10].map((k) => this.lastView[k] - viewProj[k]));
                // if really similar, no need to sort
                if (dist < 0.001) return;
            } else {
                // update vertex count
                this.sortedVertexCount = currentVertexCount;
            }
            this.lastView = viewProj;
            this.sortedVertexCount = currentVertexCount;
            // calculate depth-distances and reset indices
            this.depthCalculator.cmdCalcDepths(ctx);

            // sort by depth
            this.bitonicSorter.cmdSort(ctx);
            // very slow...
            // this.radixSorter.cmdSort({ ...ctx, distancesBuffer: this.distancesBuffer, indicesBuffer: this.indicesBuffer });

            // unroll indices to the form the renderer expects
            cmdBuf.copyBufferToBuffer(this.indicesBuffer, 0, this.depthIndexReadBuffer, 0, this.indicesBuffer.size);
        }
    }

    async getDepthIndex() {
        if (this.sortRunning && this.depthIndexReadBuffer.mapState === 'unmapped') {
            // map the gpu memory onto cpu memory
            await this.depthIndexReadBuffer.mapAsync(GPUMapMode.READ);
            // get the array buffer
            const arrayBuffer = this.depthIndexReadBuffer.getMappedRange();
            const depthIndex = new Uint32Array(arrayBuffer.slice(0, this.sortedVertexCount * BYTES_U32));
            // unmap so that GPU can use the buffer again
            this.depthIndexReadBuffer.unmap();
            this.sortRunning = false;

            return { depthIndex: depthIndex, cnt: this.sortedVertexCount };
        } else {
            return null;
        }

    }
}
