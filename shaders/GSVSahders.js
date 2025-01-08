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
uniform int resolution;
uniform int offset_border;
// int range of dynamics
uniform ivec2 dynamics;

in vec2 position;
in int index;

out vec4 vColor;
out vec2 vPosition;

uint deMorton(uint x) {
    x = x & 0x55555555u;
    x = (x ^ (x >> 1)) & 0x33333333u;
    x = (x ^ (x >> 2)) & 0x0f0f0f0fu;
    x = (x ^ (x >> 4)) & 0x00ff00ffu;
    x = (x ^ (x >> 8)) & 0x0000ffffu;
    return x;
}

uvec2 deMorton2D(uint code) {
    return uvec2(deMorton(code), deMorton(code >> 1));
}

// w at first and then xyz
vec4 quanternion_multiply(vec4 a, vec4 b) {
    vec4 res = vec4(
        a.x * b.x - dot(a.yzw, b.yzw),
        a.x * b.yzw + b.x * a.yzw + cross(a.yzw, b.yzw)
    );
    return res / sqrt(dot(res, res));
}


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
    // offset on rotation
    vec4 rot_offset;

    if(is_dynamic){
        // apply the offset
        // int mapped_index = texelFetch(atlas_texture, ivec2(( (index - dynamics.x) >> 10, (index - dynamics.x) & 0x3ff) ), 0).r;

        int mapped_index = index - dynamics.x;

        // uvec2 coor = deMorton2D(uint(index - dynamics.x));
        // int mapped_index = int(coor.y * resolution + coor.x);

        // mind the order here due to cv2 uses bgr
        uvec3 highxyz = texelFetch(highxyz_texture, ivec2((mapped_index & 0x3ff), mapped_index >> 10), 0).rgb;
        uvec3 lowxyz = texelFetch(lowxyz_texture, ivec2((mapped_index & 0x3ff), mapped_index >> 10), 0).rgb;


        // if to combine the quaternion in shader
        // uint rot_bq0 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 0) & 0x3ff), (mapped_index + resolution * resolution * 0) >> 10), 0).r;
        // uint rot_bq1 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 1) & 0x3ff), (mapped_index + resolution * resolution * 1) >> 10), 0).r;
        // uint rot_bq2 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 2) & 0x3ff), (mapped_index + resolution * resolution * 2) >> 10), 0).r;
        // uint rot_bq3 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 3) & 0x3ff), (mapped_index + resolution * resolution * 3) >> 10), 0).r;
        // rot_offset = vec4(float(rot_bq0) / 127.5 - 1.0,
        //                     float(rot_bq1) / 127.5 - 1.0,
        //                     float(rot_bq2) / 127.5 - 1.0,
        //                     float(rot_bq3) / 127.5 - 1.0);

        uvec4 rot_bq = texelFetch(rot_texture, ivec2(mapped_index & 0x3ff, mapped_index >> 10), 0);
        rot_offset = vec4(float(rot_bq.x) / 127.5 - 1.0,
                            float(rot_bq.y) / 127.5 - 1.0,
                            float(rot_bq.z) / 127.5 - 1.0,
                            float(rot_bq.w) / 127.5 - 1.0);
        rot_offset /= sqrt(dot(rot_offset, rot_offset));

        vec3 xyz_offset = vec3(uvec3(highxyz << 8u) | lowxyz) / 65535.;
        cen_position = cen_position + xyz_offset * float(offset_border) * 2. - float(offset_border); 
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
    vec3 scale = vec3(unpackHalf2x16(cov.x).xy, unpackHalf2x16(cov.y).x);
    vec4 rot = vec4(float((cov.z      ) & 0xffu) / 127.5 - 1.0, 
                    float((cov.z >> 8 ) & 0xffu) / 127.5 - 1.0, 
                    float((cov.z >> 16) & 0xffu) / 127.5 - 1.0, 
                    float((cov.z >> 24) & 0xffu) / 127.5 - 1.0);
    rot /= sqrt(dot(rot, rot));
    if(is_dynamic){
        rot = quanternion_multiply(rot, rot_offset);
    }

    mat3 S = mat3(scale.x, 0.0, 0.0, 0.0, scale.y, 0.0, 0.0, 0.0, scale.z);
    mat3 R = mat3(
        1.0 - 2.0 * (rot.z * rot.z + rot.w * rot.w), 2.0 * (rot.y * rot.z - rot.x * rot.w), 2.0 * (rot.y * rot.w + rot.x * rot.z),
        2.0 * (rot.y * rot.z + rot.x * rot.w), 1.0 - 2.0 * (rot.y * rot.y + rot.w * rot.w), 2.0 * (rot.z * rot.w - rot.x * rot.y),
        2.0 * (rot.y * rot.w - rot.x * rot.z), 2.0 * (rot.z * rot.w + rot.x * rot.y), 1.0 - 2.0 * (rot.y * rot.y + rot.z * rot.z));
    mat3 M = S * R;
    mat3 Vrk = 4.0 * transpose(M) * M;
            

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
