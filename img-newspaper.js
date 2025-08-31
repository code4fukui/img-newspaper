function hexToRgb(hex){
  const m = hex.replace('#','');
  const i = parseInt(m,16);
  return [(i>>16)&255, (i>>8)&255, i&255].map(v=>v/255);
}


function computeFit(imgW, imgH, canW, canH, mode){
  const imgAspect = imgW / imgH, canAspect = canW / canH;
  let scaleX = 1, scaleY = 1, offX = 0, offY = 0;
  if (mode === 'w'){
    // fit by width (letterbox vertically)
    scaleY = imgAspect / canAspect;
    offY = (1 - scaleY) * 0.5;
  } else {
    // fit by height (pillarbox horizontally)
    scaleX = canAspect / imgAspect;
    offX = (1 - scaleX) * 0.5;
  }
  return { scale:[scaleX, scaleY], offset:[offX, offY] };
}

export class ImageNewspaper extends HTMLElement {
  constructor() {
    super();
    const canvas = document.createElement("canvas");
    this.appendChild(canvas);
    this.style.display = "inline-block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";

    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL未対応のブラウザです');

    // init
    // --- Shaders ---
    const vertSrc = `
    attribute vec2 a_pos; // clip space
    varying vec2 v_uv;
    void main(){
      v_uv = a_pos * 0.5 + 0.5; // 0..1
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }`;

    const hasDeriv = !!gl.getExtension('OES_standard_derivatives');

  function makeFragSrc(has){
    const head = has ? `#extension GL_OES_standard_derivatives : enable
    #define HAS_DERIV 1
    ` : `#define HAS_DERIV 0
    `;
      return head + `
      precision highp float;
      varying vec2 v_uv;
      uniform sampler2D u_img;
      uniform vec2 u_res;           // canvas pixels
      uniform vec2 u_uvScale;       // image fit scale in UV
      uniform vec2 u_uvOffset;      // offset for letterbox
      uniform float u_dotSize;      // pixels between dot centers
      uniform float u_angle;        // radians
      uniform float u_contrast;     // contrast factor
      uniform float u_gamma;        // gamma for luminance
      uniform float u_bleed;        // ink bleed 0..0.5 (in cell radius fraction)
      uniform float u_grain;        // paper grain strength 0..1
      uniform float u_vig;          // vignette strength 0..1
      uniform vec3 u_paper;         // paper color sRGB
      uniform vec3 u_ink;           // ink color sRGB

      // hash-based value noise
      float hash21(vec2 p){
        p = fract(p*vec2(123.34, 345.45));
        p += dot(p, p+34.345);
        return fract(p.x*p.y);
      }

      float noise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        float a = hash21(i);
        float b = hash21(i + vec2(1.0, 0.0));
        float c = hash21(i + vec2(0.0, 1.0));
        float d = hash21(i + vec2(1.0, 1.0));
        vec2 u = f*f*(3.0-2.0*f);
        return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
      }

      // safe texture sampling with letterbox handling
      bool inside(vec2 uv){ return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0; }

      void main(){
        // Map canvas UV -> image UV (fit)
        vec2 suv = (v_uv - u_uvOffset) / u_uvScale;
        vec3 baseColor;
        bool valid = inside(suv);
        if(valid){
          baseColor = texture2D(u_img, suv).rgb;
        } else {
          baseColor = u_paper; // outside = paper
        }

        // luminance (sRGB approx)
        float lum = dot(baseColor, vec3(0.299, 0.587, 0.114));
        lum = pow(clamp(lum, 0.0, 1.0), u_gamma);
        lum = clamp((lum - 0.5) * u_contrast + 0.5, 0.0, 1.0);

        // Halftone grid in pixel space (rotated)
        vec2 center = 0.5 * u_res;                 // pixels
        vec2 p = v_uv * u_res - center;            // center origin (px)
        float ca = cos(u_angle), sa = sin(u_angle);
        vec2 rp = vec2(ca*p.x - sa*p.y, sa*p.x + ca*p.y);

        // cell center (px)
        float s = max(u_dotSize, 1.0);
        vec2 cell = (floor(rp / s) + 0.5) * s;
        float dist = length(rp - cell);

        // radius from luminance (dark = big dot)
        float r = 0.5 * s * pow(1.0 - lum, 0.92);

        // ink bleed & paper grain (procedural)
        float g = (noise(rp * 0.07) * 2.0 - 1.0) * u_grain; // -1..1 * strength
        r += u_bleed * (0.5 * s) + g * (0.12 * s);

        // anti-aliased edge
        float aa;
        #if HAS_DERIV
          aa = fwidth(dist) * 1.5;
        #else
          // Fallback: ~1px smoothing (approx) when derivatives are unavailable
          aa = 1.0;
        #endif

        float inkMask = 1.0 - smoothstep(r - aa, r + aa, dist);

        // composite ink on paper
        vec3 color = mix(u_paper, u_ink, inkMask);

        // paper grain modulation (subtle brightness/texture)
        float paperTex = noise(v_uv * u_res * 0.5 + 37.0);
        color *= (1.0 - 0.06 * u_grain + 0.12 * u_grain * (paperTex - 0.5));

        // vignette
        vec2 q = v_uv - 0.5;
        float vign = smoothstep(0.8, 0.2, length(q));
        color *= mix(1.0, vign, u_vig);

        gl_FragColor = vec4(color, 1.0);
      }
    `;
    }

    const fragSrc = makeFragSrc(hasDeriv);

    function createShader(type, src){
      const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh);
      if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
        throw new Error((type===gl.VERTEX_SHADER? 'VERT': 'FRAG')+ ' shader error:\n' + gl.getShaderInfoLog(sh));
      }
      return sh;
    }
    function createProgram(vs, fs){
      const prg = gl.createProgram(); gl.attachShader(prg, vs); gl.attachShader(prg, fs); gl.linkProgram(prg);
      if(!gl.getProgramParameter(prg, gl.LINK_STATUS)){
        throw new Error('Program link error:\n' + gl.getProgramInfoLog(prg));
      }
      return prg;
    }
    const prog = createProgram(
      createShader(gl.VERTEX_SHADER, vertSrc),
      createShader(gl.FRAGMENT_SHADER, fragSrc)
    );
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // two triangles (clip space)
    const quad = new Float32Array([
      -1,-1,  1,-1,  -1, 1,
      1,-1,  1, 1,  -1, 1
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    const a_pos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(a_pos);
    gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);

    // uniforms
    const uni = {
      u_img: gl.getUniformLocation(prog, 'u_img'),
      u_res: gl.getUniformLocation(prog, 'u_res'),
      u_uvScale: gl.getUniformLocation(prog, 'u_uvScale'),
      u_uvOffset: gl.getUniformLocation(prog, 'u_uvOffset'),
      u_dotSize: gl.getUniformLocation(prog, 'u_dotSize'),
      u_angle: gl.getUniformLocation(prog, 'u_angle'),
      u_contrast: gl.getUniformLocation(prog, 'u_contrast'),
      u_gamma: gl.getUniformLocation(prog, 'u_gamma'),
      u_bleed: gl.getUniformLocation(prog, 'u_bleed'),
      u_grain: gl.getUniformLocation(prog, 'u_grain'),
      u_vig: gl.getUniformLocation(prog, 'u_vig'),
      u_paper: gl.getUniformLocation(prog, 'u_paper'),
      u_ink: gl.getUniformLocation(prog, 'u_ink'),
    };

    // state
    const state = {
      img: null,
      fit: 'w', // 'w' or 'h'
      lockAR: true,
      dot: 8,
      angle: 45,
      contrast: 1.2,
      gamma: 1.0,
      bleed: 0.06,
      grain: 0.30,
      vig: 0.10,
      paper: '#f5f1e6',
      ink: '#111111'
    };

    // texture
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    //
    this.gl = gl;
    this.canvas = canvas;
    this.state = state;
    this.tex = tex;
    this.prog = prog;
    this.uni = uni;

    // initial draw
    this.resize(); 
    this.draw();
    window.addEventListener('resize', () => {
      this.resize();
      this.draw();
    });

    //
    const src = this.getAttribute("src");
    if (src) {
      console.log("src", src)
      const img = new Image();
      img.src = src;
      img.onload = () => {
        this.setImage(img);
        this.resize();
        this.draw();
      };
    }
  }
  resize() {
    const state = this.state;
    const canvas = this.canvas;
    const gl = this.gl;

    // CSS側のアスペクト固定を反映
    if (state.lockAR && state.img) {
      const ar = state.img.width / state.img.height;
      canvas.style.aspectRatio = `${ar}`;
      canvas.classList.add('ar-locked');   // height: auto に
    } else {
      canvas.style.removeProperty('aspect-ratio');
      canvas.classList.remove('ar-locked'); // height: 100% に戻す
    }

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(2, Math.floor(rect.width * dpr));
    const h = Math.max(2, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h){
      canvas.width = w; canvas.height = h;
    }
    gl.viewport(0,0,canvas.width, canvas.height);
  }

  draw() {
    const state = this.state;
    const canvas = this.canvas;
    const gl = this.gl;
    const tex = this.tex;
    const prog = this.prog;
    const uni = this.uni;

    if (!state.img) {
      gl.clearColor(0.96, 0.95, 0.92, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    this.resize();

    const {width: iw, height: ih} = state.img;
    const fit = computeFit(iw, ih, canvas.width, canvas.height, state.fit);

    gl.useProgram(prog);
    gl.uniform2f(uni.u_res, canvas.width*1.0, canvas.height*1.0);
    gl.uniform2f(uni.u_uvScale, fit.scale[0], fit.scale[1]);
    gl.uniform2f(uni.u_uvOffset, fit.offset[0], fit.offset[1]);
    gl.uniform1f(uni.u_dotSize, state.dot);
    gl.uniform1f(uni.u_angle, state.angle * Math.PI / 180);
    gl.uniform1f(uni.u_contrast, state.contrast);
    gl.uniform1f(uni.u_gamma, state.gamma);
    gl.uniform1f(uni.u_bleed, state.bleed);
    gl.uniform1f(uni.u_grain, state.grain);
    gl.uniform1f(uni.u_vig, state.vig);
    const paper = hexToRgb(state.paper), ink = hexToRgb(state.ink);
    gl.uniform3f(uni.u_paper, paper[0], paper[1], paper[2]);
    gl.uniform3f(uni.u_ink, ink[0], ink[1], ink[2]);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(uni.u_img, 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  
  setImage(img) {
    const state = this.state;
    const gl = this.gl;
    const tex = this.tex;

    state.img = img;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    this.resize();
    this.draw();
  }
};

customElements.define("img-newspaper", ImageNewspaper);


/*

  // UI bindings
  const el = (id)=>document.getElementById(id);
  const bindVal = (id, key, fmt=(v)=>v)=>{
    const r = el(id);
    const out = el('val' + id.charAt(0).toUpperCase()+id.slice(1));
    const update = ()=>{ state[key] = parseFloat(r.value); out && (out.textContent = fmt(state[key])); draw(); };
    r.addEventListener('input', update); update();
  };
  bindVal('dot','dot', v=>v.toFixed(1)+' px');
  bindVal('angle','angle', v=>v.toFixed(0)+' °');
  bindVal('contrast','contrast', v=>v.toFixed(2));
  bindVal('gamma','gamma', v=>v.toFixed(2));
  bindVal('bleed','bleed', v=>v.toFixed(2));
  bindVal('grain','grain', v=>v.toFixed(2));
  bindVal('vig','vig', v=>v.toFixed(2));

  el('paper').addEventListener('input', (e)=>{ state.paper = e.target.value; draw(); });
  el('ink').addEventListener('input', (e)=>{ state.ink = e.target.value; draw(); });

  el('fitW').addEventListener('click', ()=>{ state.fit='w'; draw(); });
  el('fitH').addEventListener('click', ()=>{ state.fit='h'; draw(); });

  el('save').addEventListener('click', ()=>{
    const link = document.createElement('a');
    link.download = 'newspaper-halftone.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  // file & drag-drop
  el('file').addEventListener('change', (e)=>{
    const f = e.target.files && e.target.files[0]; if(!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = ()=>{ URL.revokeObjectURL(url); setImage(img); };
    img.src = url;
  });
  const drop = el('drop');
  ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.style.borderColor='#999'; }));
  ;['dragleave','drop'].forEach(ev=>drop.addEventListener(ev, e=>{ e.preventDefault(); drop.style.borderColor='#bbb'; }));
  drop.addEventListener('drop', (e)=>{
    const f = e.dataTransfer.files && e.dataTransfer.files[0]; if(!f) return;
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = ()=>{ URL.revokeObjectURL(url); setImage(img); };
    img.src = url;
  });

  // simple embedded sample (tiny SVG rasterized via dataURL)
  el('sample').addEventListener('click', ()=>{
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='960' height='640'>
      <defs>
        <linearGradient id='g' x1='0' x2='1'>
          <stop offset='0' stop-color='#777'/>
          <stop offset='1' stop-color='#ddd'/>
        </linearGradient>
      </defs>
      <rect width='100%' height='100%' fill='url(#g)'/>
      <g fill='#0008'>
        <circle cx='340' cy='300' r='120'/>
        <rect x='520' y='210' width='200' height='180' rx='16'/>
      </g>
      <text x='40' y='80' font-size='64' font-family='sans-serif' fill='#222'>Newspaper Halftone</text>
      <text x='40' y='140' font-size='24' font-family='sans-serif' fill='#333'>Drop your photo here</text>
    </svg>`;
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image(); img.crossOrigin='anonymous';
    img.onload = ()=> setImage(img);
    img.src = url;
  });
el('lockAR').addEventListener('change', (e)=>{
  state.lockAR = e.target.checked;
  resize(); 
  draw();
});


})();
*/
