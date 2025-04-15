import { BYTES_U64 } from './utils/utils.js';

const NANO_TO_MILISECONDS = 0.000001;

/// Big amount of queries to never have to carry about it
const MAX_QUERY_COUNT = 1024;
/// Each pass has BEGIN and END timestamp query
const QUERIES_PER_PASS = 2;
const TOTAL_MAX_QUERIES = MAX_QUERY_COUNT * QUERIES_PER_PASS;

/**
 * https://github.com/Scthe/Rust-Vulkan-TressFX/blob/master/src/gpu_profiler.rs
 *
 * webgpu API: https://webgpufundamentals.org/webgpu/lessons/webgpu-timing.html
 */
export class GPUProfiler {

  get enabled() {
    return this._profileThisFrame && this.hasRequiredFeature;
  }

  // device: GPUDevice
  constructor(device) {
    this._profileThisFrame = false;
    // bool
    this.hasRequiredFeature = device.features.has('timestamp-query');
    if (!this.hasRequiredFeature) {
      // we should never use them if no feature available
      this.queryPool = undefined;
      this.queryInProgressBuffer = undefined;
      this.resultsBuffer = undefined;
      return;
    }

    // GPUQuerySet;
    this.queryPool = device.createQuerySet({
      type: 'timestamp',
      count: TOTAL_MAX_QUERIES,
    });

    // GPUBuffer
    this.queryInProgressBuffer = device.createBuffer({
      label: 'profiler-in-progress',
      size: this.queryPool.count * BYTES_U64,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    // GPUBuffer
    this.resultsBuffer = device.createBuffer({
      label: 'profiler-results',
      size: this.queryInProgressBuffer.size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  static async createGpuDevice() {
    try {
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: 'high-performance',
      });
      const onError = (msg) =>
        console.error(`WebGPU init error: '${msg}'`);

      if (!adapter) {
        // On web: check if https. On ff, WebGPU is under dev flag.
        onError('No adapter found. WebGPU seems to be unavailable.');
        return null;
      }

      const canTimestamp = adapter.features.has('timestamp-query');
      let requiredFeatures = [];
      if (canTimestamp) {
        requiredFeatures.push('timestamp-query');
      }

      const device = await adapter?.requestDevice({ requiredFeatures });
      if (!device) {
        onError('Failed to get GPUDevice from the adapter.');
        return null;
      }

      return device;
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  // bool
  profileNextFrame(enabled) {
    this._profileThisFrame = enabled;
  }

  beginFrame() {
    while (this.currentFrameScopes.length > 0) {
      this.currentFrameScopes.pop();
    }
  }

  // cmdBuf: GPUCommandEncoder
  endFrame(cmdBuf) {
    if (!this.enabled) {
      return;
    }

    const queryCount = this.currentFrameScopes.length * QUERIES_PER_PASS;
    cmdBuf.resolveQuerySet(
      this.queryPool,
      0,
      queryCount,
      this.queryInProgressBuffer,
      0
    );
    if (this.resultsBuffer.mapState === 'unmapped') {
      cmdBuf.copyBufferToBuffer(
        this.queryInProgressBuffer,
        0,
        this.resultsBuffer,
        0,
        this.resultsBuffer.size
      );
    }
  }

  async scheduleRaportIfNeededAsync(onResult) {
    if (!this.enabled || this.currentFrameScopes.length == 0) {
      this._profileThisFrame = false;
      return;
    }

    this._profileThisFrame = false;
    const scopeNames = this.currentFrameScopes.slice();

    if (this.resultsBuffer.mapState === 'unmapped') {
      await this.resultsBuffer.mapAsync(GPUMapMode.READ);
      const times = new BigInt64Array(this.resultsBuffer.getMappedRange());
      const result = scopeNames.map(
        (name, idx) => {
          // all on gpu
          let time = 0;
          const start = times[idx * QUERIES_PER_PASS];
          const end = times[idx * QUERIES_PER_PASS + 1];
          time = Number(end - start) * NANO_TO_MILISECONDS;
          return [name, time];
        }
      );
      this.resultsBuffer.unmap();

      onResult?.(result);
    }
  }

  /** Provide to beginCompute/beginRenderPass's `timestampWrites` */
  createScopeGpu(name) {
    if (!this.enabled) {
      return undefined;
    }

    const queryId = this.currentFrameScopes.length;
    this.currentFrameScopes.push(name);

    return {
      querySet: this.queryPool,
      beginningOfPassWriteIndex: queryId * QUERIES_PER_PASS,
      endOfPassWriteIndex: queryId * QUERIES_PER_PASS + 1,
    };
  }

  /*
  NOTE: The geniuses actually removed this feature... WTF?!

  /**If you want to start/end code block manually * /
  startRegionGpu(cmdBuf: GPUCommandEncoder, name: string): ProfilerRegionId {
    if (!this.enabled) {
      return undefined;
    }

    const queryId = this.currentFrameScopes.length;
    this.currentFrameScopes.push([name, 'gpu', 0]);
    cmdBuf.writeTimestamp(this.queryPool, queryId * 2);

    return queryId;
  }

  endRegionGpu(cmdBuf: GPUCommandEncoder, token: ProfilerRegionId) {
    if (!this.enabled || token === undefined) return;

    cmdBuf.writeTimestamp(this.queryPool, token * 2 + 1);
  }
  */

}
