/**
 * NOVABALL render-world — goals.
 *  - Frame: thick neon tubes (exact physics radius profile) in the defending team's color with energy pulses
 *    running along them; flares in the scoring team's color on goals (never a white-out).
 *  - Net: hex-light mesh on the goal box sides/roof (additive, see-through), energy flowing toward the back.
 *  - Portal: animated energy vortex on the back wall (opaque, reads as a deep void with a bright core).
 * Both goals share each material (3 draw calls total), the team is a vertex attribute.
 */
import { AdditiveBlending, DoubleSide, Group, Mesh, ShaderMaterial } from 'three';
import { buildGoalFrameGeometry, buildGoalGeometries } from './ArenaGeometry';
import { GLSL_ARENA_UNIFORMS, type ArenaUniforms } from './ArenaUniforms';
import { GLSL_ARENA, GLSL_HASH, GLSL_HEX, GLSL_NOISE2 } from './glsl';

const FRAME_VERT = /* glsl */ `
attribute float aTeam;
attribute float aArc;
attribute float aRad;
varying vec3 vN;
varying vec3 vWP;
varying float vTeam;
varying float vArc;
varying float vRad;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vTeam = aTeam;
  vArc = aArc;
  vRad = aRad;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAME_FRAG = /* glsl */ `
${GLSL_ARENA_UNIFORMS}
varying vec3 vN;
varying vec3 vWP;
varying float vTeam;
varying float vArc;
varying float vRad;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWP);
  float ndv = abs(dot(N, V));
  vec3 team = mix(uTeam0, uTeam1, step(0.5, vTeam));
  float flash = mix(uGoalFlash.x, uGoalFlash.y, step(0.5, vTeam));
  // no surge tint on the frame: during a ZERO-G SURGE the goals must still read VOLT cyan / BLAZE orange
  // energy pulses travelling along the frame (both directions from the crossbar)
  float pulse = pow(max(0.5 + 0.5 * sin(vArc * 1.6 - uTime * 6.0), 0.0), 10.0);
  float pulse2 = pow(max(0.5 + 0.5 * sin(vArc * 0.55 + uTime * 2.2), 0.0), 6.0);
  float core = pow(max(ndv, 0.0), 2.0);
  vec3 col = team * (2.4 + 1.6 * pulse + 0.8 * pulse2);
  col += mix(team, vec3(1.0), 0.65) * core * 2.6;
  // goal celebration: flare in the scoring team's colour (not a white-out)
  col = mix(col, uFlashColor * 3.2 + vec3(0.35), flash * 0.6);
  // taper tips fade into the floor
  col *= smoothstep(0.0, 0.08, vRad);
  gl_FragColor = vec4(col, 1.0);
}
`;

const GOAL_VERT = /* glsl */ `
attribute float aTeam;
varying vec3 vN;
varying vec3 vWP;
varying float vTeam;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWP = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vTeam = aTeam;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const NET_FRAG = /* glsl */ `
${GLSL_HASH}
${GLSL_HEX}
${GLSL_ARENA}
${GLSL_ARENA_UNIFORMS}
varying vec3 vN;
varying vec3 vWP;
varying float vTeam;
void main() {
  // parts of the goal box in front of the goal line are open arena: cut them
  if (nbMainFree(vWP) > 0.02) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vWP);
  float ndv = abs(dot(N, V));
  vec3 an = abs(N);
  vec2 uv = an.x > 0.5 ? vWP.zy : (an.y > 0.5 ? vWP.xz : vWP.xy);
  vec2 hp = uv / 0.62;
  vec4 hx = nbHex(hp);
  float fw = length(fwidth(hp));
  float line = 1.0 - smoothstep(0.04, 0.04 + fw * 1.3, hx.z);
  line = mix(line, 0.2, smoothstep(0.15, 0.5, fw));
  vec3 team = mix(uTeam0, uTeam1, step(0.5, vTeam));
  team = mix(team, uSurgeColor, uSurge * 0.2);
  float flash = mix(uGoalFlash.x, uGoalFlash.y, step(0.5, vTeam));
  float depth = clamp((abs(vWP.z) - NB_L) / NB_GD, 0.0, 1.0);
  float flow = pow(max(0.5 + 0.5 * sin(abs(vWP.z) * 2.2 - uTime * 4.0 + hx.w * 2.0), 0.0), 6.0);
  float fres = pow(max(1.0 - ndv, 0.0), 2.0);
  float I = line * (0.16 + 0.35 * fres + 0.35 * flow * (0.3 + depth)) + 0.015 + 0.05 * fres;
  I *= 1.0 + flash * 2.0;
  vec3 col = mix(team, vec3(1.0), flash * 0.12) * I;
  col += nbRipples(vWP) * (0.3 + line);
  col *= smoothstep(0.0, 0.04, vWP.y);
  gl_FragColor = vec4(col, 1.0);
}
`;

const PORTAL_FRAG = /* glsl */ `
${GLSL_HASH}
${GLSL_NOISE2}
${GLSL_ARENA}
${GLSL_ARENA_UNIFORMS}
varying vec3 vN;
varying vec3 vWP;
varying float vTeam;
void main() {
  vec3 team = mix(uTeam0, uTeam1, step(0.5, vTeam));
  team = mix(team, uSurgeColor, uSurge * 0.2);
  float flash = mix(uGoalFlash.x, uGoalFlash.y, step(0.5, vTeam));
  float side = vTeam > 0.5 ? 1.0 : -1.0;
  // local coords on the back wall (x mirrored so both portals spin the same way on screen)
  vec2 q = vec2(vWP.x * side, vWP.y - NB_GH * 0.5);
  vec2 qn = q / vec2(NB_G, NB_GH * 0.5);
  float r = length(q) / 5.2;
  float a = atan(q.y, q.x);
  float t = uTime * (0.9 + flash * 2.5);
  float spiral = a * 2.0 + log(r + 0.05) * 3.2 - t * 1.6;
  float n = nbFbm2(vec2(spiral * 1.2, r * 4.0 - t * 0.8));
  float arms = pow(max(0.5 + 0.5 * sin(spiral * 3.0 + n * 4.0), 0.0), 3.0);
  float swirl = arms * smoothstep(1.35, 0.15, r) * (0.55 + 0.9 * n);
  // restrained team-coloured core: on-target shots fly right into it, so it must not swallow the ball
  float core = exp(-r * r * 9.0) * 0.9 + exp(-r * 2.6) * 0.25;
  float rim = smoothstep(0.75, 1.0, max(abs(qn.x), abs(qn.y)));
  vec3 deep = team * 0.03;
  vec3 col = deep + team * swirl * 1.6 + mix(team, vec3(1.0), 0.2) * core;
  col += team * rim * 0.35;
  col *= 1.0 + flash * 1.2;
  col += uFlashColor * flash * 1.5 * smoothstep(1.2, 0.0, r);
  gl_FragColor = vec4(col, 1.0);
}
`;

export class Goals {
  readonly group = new Group();
  readonly frameMesh: Mesh;
  readonly netMesh: Mesh;
  readonly portalMesh: Mesh;
  private readonly frameMat: ShaderMaterial;
  private readonly netMat: ShaderMaterial;
  private readonly portalMat: ShaderMaterial;

  constructor(uniforms: ArenaUniforms) {
    this.group.name = 'Goals';
    this.frameMat = new ShaderMaterial({
      name: 'NovaGoalFrame',
      uniforms,
      vertexShader: FRAME_VERT,
      fragmentShader: FRAME_FRAG,
    });
    this.frameMesh = new Mesh(buildGoalFrameGeometry(), this.frameMat);
    this.frameMesh.name = 'GoalFrames';

    const { net, portal } = buildGoalGeometries();
    this.netMat = new ShaderMaterial({
      name: 'NovaGoalNet',
      uniforms,
      vertexShader: GOAL_VERT,
      fragmentShader: NET_FRAG,
      transparent: true,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.netMesh = new Mesh(net, this.netMat);
    this.netMesh.name = 'GoalNets';
    this.netMesh.renderOrder = 3;

    this.portalMat = new ShaderMaterial({
      name: 'NovaGoalPortal',
      uniforms,
      vertexShader: GOAL_VERT,
      fragmentShader: PORTAL_FRAG,
      side: DoubleSide,
    });
    this.portalMesh = new Mesh(portal, this.portalMat);
    this.portalMesh.name = 'GoalPortals';

    this.group.add(this.frameMesh, this.netMesh, this.portalMesh);
  }

  dispose(): void {
    this.frameMesh.geometry.dispose();
    this.netMesh.geometry.dispose();
    this.portalMesh.geometry.dispose();
    this.frameMat.dispose();
    this.netMat.dispose();
    this.portalMat.dispose();
  }
}
