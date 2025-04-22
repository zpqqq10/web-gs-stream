@group(0) @binding(0)
var<storage, read> depthIndex: array<u32>;

@group(0) @binding(1)
var<storage, read_write> unrolledDepthIndices: array<u32>;

@group(0) @binding(2)
var<uniform> vertexCount: u32;

@compute
@workgroup_size(1) // TODO?
fn main(
@builtin(global_invocation_id) global_id: vec3<u32>,
) {
    let itemsPerThread = u32(__ITEMS_PER_THREAD__);
    let startIdx = global_id.x * itemsPerThread;
    let endIdx = (global_id.x + 1u) * itemsPerThread;
    for (var i = startIdx; i < endIdx && i < vertexCount; i++) {
        unrolledDepthIndices[i] = depthIndex[i];
    }
    
    // let verticesPerSplat = u32(__VERTICES_PER_SPLAT__);
    // for (var i = startIdx; i < endIdx && i < vertexCount; i++) {
    //     let idx = depthIndex[i];
    //     for (var j = 0u; j < verticesPerSplat; j++) {
    //         unrolledDepthIndices[i * verticesPerSplat + j] = idx * verticesPerSplat + j;
    //     }
    // }
}