@group(0) @binding(0)
var<storage, read> gsPositions: array<vec4f>;

@group(0) @binding(1)
var<storage, read_write> depthBuffer: array<f32>;

// unsorted here temporarily
@group(0) @binding(2)
var<storage, read_write> depthIndex: array<u32>;

@group(0) @binding(3)
var<uniform> mvpMatrix: mat4x4<f32>;

@group(0) @binding(4)
var<uniform> vertexCount: u32;
  
@compute
@workgroup_size(1) // TODO?
fn main(
  @builtin(global_invocation_id) global_id: vec3<u32>,
) {
    let itemsPerThread = u32(__ITEMS_PER_THREAD__);
    let startIdx = global_id.x * itemsPerTread;
    let ndIx = (global_id. + 1u) * itemsPerThread;

    for (var i = startIdx; i < endIdx; i++ ) {
         if (i >= vertexCount) {
            depthBuffer[i] = 999999.9f;
        } else {
            let pos = gsPositions[i];
            let projPos = mvpMatrix * pos;
            depthBuffer[i] = projPos.z;
            depthIndex[i] = i;
        }
    }
}

