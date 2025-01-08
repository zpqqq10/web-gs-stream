export const vertexShaderSource = `
#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D gs_texture;
uniform highp isampler2D atlas_texture;
uniform highp usampler2D highxyz_texture;
uniform highp usampler2D lowxyz_texture;
uniform highp usampler2D rot_texture;
uniform mat4 projection, view;
uniform vec2 focal;
uniform vec2 viewport;
uniform uint timestamp;
uniform int offset_border;
// int range of dynamics
uniform ivec2 dynamics;

in vec2 position;
in int index;

out vec4 vColor;
out vec2 vPosition;

void main () {
    // xyz center
    uvec4 cen = texelFetch(gs_texture, ivec2((uint(index) & 0x3ffu) << 1, uint(index) >> 10), 0);
    uint visible_ts = cen.w & 0xffffu;
    uint invisible_ts = (cen.w >> 16u) & 0xffffu;
    vec3 cen_position = uintBitsToFloat(cen.xyz);
    if (timestamp < visible_ts || timestamp >= invisible_ts){
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }
    bool is_dynamic = (index >= dynamics.x && index < dynamics.y);
    vec3 debug;

    if(is_dynamic){
        // apply the offset
        // int mapped_index = texelFetch(atlas_texture, ivec2(((index - dynamics.x) & 0x3ff), (index - dynamics.x) >> 10), 0).r;

        int mapped_index = index - dynamics.x;
        // rgb ( bgr for cv2 )
        uvec3 highxyz = texelFetch(highxyz_texture, ivec2((mapped_index & 0x3ff), mapped_index >> 10), 0).rgb;
        uvec3 lowxyz = texelFetch(lowxyz_texture, ivec2((mapped_index & 0x3ff), mapped_index >> 10), 0).rgb;
        uvec4 rot = texelFetch(rot_texture, ivec2((mapped_index & 0x3ff), mapped_index >> 10), 0);

        vec3 xyz_offset = vec3(uvec3(highxyz << 8u) | lowxyz) / 65535.;
        cen_position = cen_position + xyz_offset * float(offset_border) * 2. - float(offset_border); 
        // debug = xyz_offset;
        // TODO calculate rotation 先测试位移加得对不对，然后直接在这里计算旋转矩阵
    } 
    else {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    vec4 cam = view * vec4(cen_position, 1);
    vec4 pos2d = projection * cam;
    float clip = 1.2 * pos2d.w;
    if (pos2d.z < -clip || 
        pos2d.x < -clip || pos2d.x > clip || 
        pos2d.y < -clip || pos2d.y > clip
        ) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }

    uvec4 cov = texelFetch(gs_texture, ivec2(((uint(index) & 0x3ffu) << 1) | 1u, uint(index) >> 10), 0);
    vec2 u1 = unpackHalf2x16(cov.x), u2 = unpackHalf2x16(cov.y), u3 = unpackHalf2x16(cov.z);
    // covariance matrix in 3D
    mat3 Vrk = mat3(u1.x, u1.y, u2.x, u1.y, u2.y, u3.x, u2.x, u3.x, u3.y);

    // Jacobian matrix
    // gradient of (u, v) w.r.t. (x, y, z)
    mat3 J = mat3(
        focal.x / cam.z, 0., -(focal.x * cam.x) / (cam.z * cam.z),
        0., -focal.y / cam.z, (focal.y * cam.y) / (cam.z * cam.z),
        0., 0., 0.
    );

    // covariance matrix in 2D
    mat3 T = transpose(mat3(view)) * J;
    mat3 cov2d = transpose(T) * Vrk * T;

    float mid = (cov2d[0][0] + cov2d[1][1]) / 2.0;
    float radius = length(vec2((cov2d[0][0] - cov2d[1][1]) / 2.0, cov2d[0][1]));
    float lambda1 = mid + radius, lambda2 = mid - radius;

    if(lambda2 < 0.0) return;
    vec2 diagonalVector = normalize(vec2(cov2d[0][1], lambda1 - cov2d[0][0]));
    vec2 majorAxis = min(sqrt(2.0 * lambda1), 1024.0) * diagonalVector;
    vec2 minorAxis = min(sqrt(2.0 * lambda2), 1024.0) * vec2(diagonalVector.y, -diagonalVector.x);

    //                                                          r                      g                      b                     a 
    vColor = clamp(pos2d.z/pos2d.w+1.0, 0.0, 1.0) * vec4((cov.w) & 0xffu, (cov.w >> 8) & 0xffu, (cov.w >> 16) & 0xffu, (cov.w >> 24) & 0xffu) / 255.0;
    // if (is_dynamic) {
    //     vColor = vec4(debug, 1.0);
    // }
    vPosition = position;

    vec2 vCenter = vec2(pos2d) / pos2d.w;
    gl_Position = vec4(
        vCenter
        + position.x * majorAxis / viewport
        + position.y * minorAxis / viewport, 0.0, 1.0);

}
`.trim();

export const fragmentShaderSource = `
#version 300 es
precision highp float;

in vec4 vColor;
in vec2 vPosition;

out vec4 fragColor;

void main () {
    float A = -dot(vPosition, vPosition);
    if (A < -4.0) discard;
    float B = exp(A) * vColor.a;
    fragColor = vec4(B * vColor.rgb, B);
}

`.trim();
