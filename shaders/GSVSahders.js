export const vertexShaderSource = `
#version 300 es
precision highp float;
precision highp int;

uniform highp usampler2D gs_texture;
uniform highp usampler2D atlas_texture;
// 2, 3, 4
uniform highp usampler2D highxyz_texture;
uniform highp usampler2D lowxyz_texture;
uniform highp usampler2D rot_texture;
// for overlap 5, 6, 7
uniform highp usampler2D olhighxyz_texture;
uniform highp usampler2D ollowxyz_texture;
uniform highp usampler2D olrot_texture;
// high-order sh, 8
uniform highp usampler2D sh_texture;

uniform mat4 projection, view;
uniform vec2 focal;
uniform vec2 viewport;
uniform uint timestamp;
uniform int resolution;
uniform int offset_border;
uniform float extent;
// camera center
uniform vec3 camera_center;
// info about time, in gop, overlap, duration
uniform uint gop;
uniform uint overlap;
uniform uint duration;
// int range of dynamics
uniform ivec2 dynamics;

// for overlap
uniform ivec2 oldynamics;

in vec2 position;
in int index;

out vec4 vColor;
out vec2 vPosition;

// sh coefficients
float PISQRT = 1.77245385091f;
float SH_C0 = 0.28209479177387814f;
float SH_C1 = 0.4886025119029199f;
float SH_C2[] = float[](
    1.0925484305920792f,
    -1.0925484305920792f,
    0.31539156525252005f,
    -1.0925484305920792f,
    0.5462742152960396f
);
float SH_C3[] = float[](
    -0.5900435899266435f,
    2.890611442640554f,
    -0.4570457994644658f,
    0.3731763325901154f,
    -0.4570457994644658f,
    1.445305721320277f,
    -0.5900435899266435f
);

// w at first and then xyz
vec4 quanternion_multiply(vec4 a, vec4 b) {
    vec4 res = vec4(
        a.x * b.x - dot(a.yzw, b.yzw),
        a.x * b.yzw + b.x * a.yzw + cross(a.yzw, b.yzw)
    );
    return res / sqrt(dot(res, res));
}

vec3 computeSH(uint rest_idx, vec3 gs_position, vec3 direct_color){
    vec3 sh[15];
    // direction for sh calculation
    vec3 shdir = gs_position - camera_center;
    shdir = normalize(shdir);
    float x = shdir.x, y = shdir.y, z = shdir.z;
    float xx = x * x, yy = y * y, zz = z * z;
    float xy = x * y, yz = y * z, zx = z * x;
    // fetch the sh coefficients
    uvec3 packed_sh = texelFetch(sh_texture, ivec2(((rest_idx & 0x3ffu) << 3u) | 7u, rest_idx >> 10u), 0).rgb;
    sh[14] = vec3(unpackHalf2x16(packed_sh.x).xy, unpackHalf2x16(packed_sh.y).x);
    for (uint i = 0u; i < 7u; i++){
        packed_sh = texelFetch(sh_texture, ivec2(((rest_idx & 0x3ffu) << 3u) | i, rest_idx >> 10u), 0).rgb;
        sh[i * 2u + 0u] = vec3(unpackHalf2x16(packed_sh.x).xy, unpackHalf2x16(packed_sh.y).x);
        sh[i * 2u + 1u] = vec3(unpackHalf2x16(packed_sh.y).y, unpackHalf2x16(packed_sh.z).xy);
    }
    
    vec3 result = SH_C0 * direct_color;
    result = result - SH_C1 * y * sh[0] + SH_C1 * z * sh[1] - SH_C1 * x * sh[2];
    result = result +
				SH_C2[0] * xy * sh[3] +
				SH_C2[1] * yz * sh[4] +
				SH_C2[2] * (2.0f * zz - xx - yy) * sh[5] +
				SH_C2[3] * zx * sh[6] +
				SH_C2[4] * (xx - yy) * sh[7];
    result = result +
                SH_C3[0] * y * (3.0f * xx - yy) * sh[8] +
                SH_C3[1] * xy * z * sh[9] +
                SH_C3[2] * y * (4.0f * zz - xx - yy) * sh[10] +
                SH_C3[3] * z * (2.0f * zz - 3.0f * xx - 3.0f * yy) * sh[11] +
                SH_C3[4] * x * (4.0f * zz - xx - yy) * sh[12] +
                SH_C3[5] * z * (xx - yy) * sh[13] +
                SH_C3[6] * x * (xx - 3.0f * yy) * sh[14];
	result += 0.5;
    result = clamp(result, 0.0, 1.0);
    return result;
}

void main () {
    // xyz center
    uvec3 cen = texelFetch(gs_texture, ivec2((index & 0x3ff) * 3 + 0, index >> 10), 0).rgb;
    vec3 cen_position = uintBitsToFloat(cen);
    // timestamp and scale
    uvec3 t_s = texelFetch(gs_texture, ivec2((index & 0x3ff) * 3 + 1, index >> 10), 0).rgb;
    uint visible_ts = t_s.x & 0xffffu;
    uint invisible_ts = (t_s.x >> 16u) & 0xffffu;
    bool is_fadeout = ((timestamp >= invisible_ts) && (timestamp < (invisible_ts + overlap))
                && (timestamp > 5u) && (duration - timestamp > overlap)); ;
    bool is_fadein = ((timestamp >= visible_ts) && (timestamp < (visible_ts + overlap)) 
                && (timestamp > 5u));

    if ((timestamp < visible_ts) || (timestamp >= (invisible_ts + overlap))) {
        gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        return;
    }
    bool is_dynamic = (index >= dynamics.x && index < dynamics.y);
    bool is_oldynamic = (index >= oldynamics.x && index < oldynamics.y);

    // offset on rotation
    vec4 rot_offset;
    vec4 olrot_offset;

    if(is_dynamic){
        // apply the offset
        // get the index in the pixel space from morton order
        // morton order is (index - dynamics.x)
        uint mapped_index = texelFetch(atlas_texture, ivec2(((index - dynamics.x) & 0x3ff), (index - dynamics.x) >> 10), 0).r;

        // mind the order here due to cv2 uses bgr
        uvec3 highxyz = texelFetch(highxyz_texture, ivec2((mapped_index & 0x3ffu), mapped_index >> 10), 0).rgb;
        uvec3 lowxyz = texelFetch(lowxyz_texture, ivec2((mapped_index & 0x3ffu), mapped_index >> 10), 0).rgb;


        // if to combine the quaternion in shader
        // uint rot_bq0 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 0) & 0x3ffu), (mapped_index + resolution * resolution * 0) >> 10), 0).r;
        // uint rot_bq1 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 1) & 0x3ffu), (mapped_index + resolution * resolution * 1) >> 10), 0).r;
        // uint rot_bq2 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 2) & 0x3ffu), (mapped_index + resolution * resolution * 2) >> 10), 0).r;
        // uint rot_bq3 = texelFetch(rot_texture, 
        //     ivec2(((mapped_index + resolution * resolution * 3) & 0x3ffu), (mapped_index + resolution * resolution * 3) >> 10), 0).r;
        // rot_offset = vec4(float(rot_bq0) / 127.5 - 1.0,
        //                     float(rot_bq1) / 127.5 - 1.0,
        //                     float(rot_bq2) / 127.5 - 1.0,
        //                     float(rot_bq3) / 127.5 - 1.0);

        uvec4 rot_bq = texelFetch(rot_texture, ivec2(mapped_index & 0x3ffu, mapped_index >> 10), 0);
        rot_offset = vec4(float(rot_bq.x) / 127.5 - 1.0,
                            float(rot_bq.y) / 127.5 - 1.0,
                            float(rot_bq.z) / 127.5 - 1.0,
                            float(rot_bq.w) / 127.5 - 1.0);
        rot_offset /= sqrt(dot(rot_offset, rot_offset));

        vec3 xyz_offset = vec3(uvec3(highxyz << 8u) | lowxyz) / 65535.;
        cen_position = cen_position + xyz_offset * float(offset_border) * 2. - float(offset_border); 
    } else if (is_oldynamic) {
        // apply the offset
        uint mapped_index = texelFetch(atlas_texture, ivec2(((index - oldynamics.x) & 0x3ff), (index - oldynamics.x) >> 10), 0).r;

        // mind the order here due to cv2 uses bgr
        uvec3 highxyz = texelFetch(olhighxyz_texture, ivec2((mapped_index & 0x3ffu), mapped_index >> 10), 0).rgb;
        uvec3 lowxyz = texelFetch(ollowxyz_texture, ivec2((mapped_index & 0x3ffu), mapped_index >> 10), 0).rgb;


        uvec4 rot_bq = texelFetch(olrot_texture, ivec2(mapped_index & 0x3ffu, mapped_index >> 10), 0);
        olrot_offset = vec4(float(rot_bq.x) / 127.5 - 1.0,
                            float(rot_bq.y) / 127.5 - 1.0,
                            float(rot_bq.z) / 127.5 - 1.0,
                            float(rot_bq.w) / 127.5 - 1.0);
        olrot_offset /= sqrt(dot(olrot_offset, olrot_offset));

        vec3 xyz_offset = vec3(uvec3(highxyz << 8u) | lowxyz) / 65535.;
        cen_position = cen_position + xyz_offset * float(offset_border) * 2. - float(offset_border); 
    } 

    // coordinate in camera space
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
    
    // if scales are calculated outside
    // vec3 scale = vec3(unpackHalf2x16(t_s.y).xy, unpackHalf2x16(t_s.z).x);
    vec3 scale = vec3(t_s.y & 0xffffu, (t_s.y >> 16u) & 0xffffu, t_s.z & 0xffffu) / 4095.0 * extent;
    // rotation, rgba & rest_idx
    uvec3 cov = texelFetch(gs_texture, ivec2((index & 0x3ff) * 3 + 2, index >> 10), 0).rgb;
    vec4 rot = vec4(float((cov.x      ) & 0xffu) / 127.5 - 1.0, 
                    float((cov.x >> 8 ) & 0xffu) / 127.5 - 1.0, 
                    float((cov.x >> 16) & 0xffu) / 127.5 - 1.0, 
                    float((cov.x >> 24) & 0xffu) / 127.5 - 1.0);
    rot /= sqrt(dot(rot, rot));
    if(is_dynamic){
        rot = quanternion_multiply(rot, rot_offset);
    } else if (is_oldynamic) {
        rot = quanternion_multiply(rot, olrot_offset);
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

    vColor = clamp(pos2d.z/pos2d.w+1.0, 0.0, 1.0) * 
        //          r                      g                      b                     a 
        vec4((cov.y) & 0xffu, (cov.y >> 8) & 0xffu, (cov.y >> 16) & 0xffu, (cov.y >> 24) & 0xffu) / 255.0;
    vColor.rgb = PISQRT * 2. *vColor.rgb - PISQRT;
    uint sh_idx = cov.z;
    // vColor.rgb = SH_C0 * vColor.rgb + .5;
    vColor.rgb = computeSH(sh_idx, cen_position, vColor.rgb);
    vColor.a = is_fadein ? vColor.a * float(timestamp - visible_ts + 1u) / float(overlap + 1u)
                    : (is_fadeout ? vColor.a * float(invisible_ts + overlap - timestamp) / float(overlap + 1u) 
                        : vColor.a);
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
    float B = exp(A) * vColor.a;
    if (B < 1. / 255.) discard;
    fragColor = vec4(B * vColor.rgb, B);
}

`.trim();
