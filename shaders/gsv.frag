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