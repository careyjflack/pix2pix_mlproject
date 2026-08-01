const SIZE = 256;
const SCALE = 2;
const DISPLAY = SIZE * SCALE; // 512
const STROKE_WEIGHT = 0.5;

let inputImg, inputCanvas, modelCanvas, output, statusMsg;
let pix2pix, transferBtn, clearBtn, modelFileInput, imageFileInput;
let isDrawing = false;
let drewThisStroke = false;
let firstSketchDone = false;
let currentModelUrl = null;
let modelReady = false;
let modelLoadTimeoutId = null;

// Step 1: point this at the model file that should live inside the site.
// Put your .pict file in the model/ folder and keep the same relative path here.
const BUNDLED_MODEL_PATH = 'model/your-model.pict';

// ── Floyd-Steinberg dither (color) ───────────────────────────────────────────
function ditherFloydSteinbergColor(pg) {
  pg.loadPixels();
  const w = pg.width, h = pg.height;

  const r = new Float32Array(w * h);
  const g = new Float32Array(w * h);
  const b = new Float32Array(w * h);

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    r[i] = pg.pixels[o];
    g[i] = pg.pixels[o + 1];
    b[i] = pg.pixels[o + 2];
  }

  const levels = 4;
  const step = 255 / (levels - 1);
  const clamp = v => Math.min(255, Math.max(0, v));
  const quantize = v => Math.round(Math.round(v / step) * step);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const oldR = r[idx], oldG = g[idx], oldB = b[idx];
      const newR = quantize(oldR), newG = quantize(oldG), newB = quantize(oldB);
      r[idx] = newR; g[idx] = newG; b[idx] = newB;
      const errR = oldR - newR, errG = oldG - newG, errB = oldB - newB;
      if (x + 1 < w) {
        r[idx+1] = clamp(r[idx+1] + errR*7/16);
        g[idx+1] = clamp(g[idx+1] + errG*7/16);
        b[idx+1] = clamp(b[idx+1] + errB*7/16);
      }
      if (y + 1 < h) {
        if (x - 1 >= 0) {
          r[idx+w-1] = clamp(r[idx+w-1] + errR*3/16);
          g[idx+w-1] = clamp(g[idx+w-1] + errG*3/16);
          b[idx+w-1] = clamp(b[idx+w-1] + errB*3/16);
        }
        r[idx+w] = clamp(r[idx+w] + errR*5/16);
        g[idx+w] = clamp(g[idx+w] + errG*5/16);
        b[idx+w] = clamp(b[idx+w] + errB*5/16);
        if (x + 1 < w) {
          r[idx+w+1] = clamp(r[idx+w+1] + errR*1/16);
          g[idx+w+1] = clamp(g[idx+w+1] + errG*1/16);
          b[idx+w+1] = clamp(b[idx+w+1] + errB*1/16);
        }
      }
    }
  }

  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    pg.pixels[o]   = r[i];
    pg.pixels[o+1] = g[i];
    pg.pixels[o+2] = b[i];
    pg.pixels[o+3] = 255;
  }
  pg.updatePixels();
}

function setup() {
  pixelDensity(1);

  inputCanvas = createCanvas(DISPLAY, DISPLAY);
  inputCanvas.class('border-box').parent('input');

  modelCanvas = createGraphics(SIZE, SIZE);
  modelCanvas.pixelDensity(1);

  background(0);

  output    = select('#output');
  statusMsg = select('#status');

  transferBtn = select('#transferBtn');
  clearBtn    = select('#clearBtn');
  clearBtn.mousePressed(clearCanvas);

  modelFileInput = select('#modelFileInput');
  if (modelFileInput) modelFileInput.elt.addEventListener('change', handleModelFile);

  imageFileInput = select('#imageFileInput');
  if (imageFileInput) imageFileInput.elt.addEventListener('change', handleImageFile);

  stroke(255);
  strokeWeight(STROKE_WEIGHT);
  strokeCap(ROUND);
  strokeJoin(ROUND);

  // p5 accessibility: describe the canvas for screen readers
  describe(
    'A black 512 by 512 pixel drawing canvas. Use a mouse or touch to sketch a face using thin white lines on a black background, or upload your own image. Draw simple outlines for eyebrows, eyes, a nose, and a mouth, then click the Transfer button to generate an AI-rendered image from your sketch.'
  );

  transferBtn.mousePressed(transfer);

  // Step 2: try to load a bundled model automatically when the page opens.
  transferBtn.attribute('disabled', '');
  loadBundledModel();
}

function draw() {
  if (mouseIsPressed) {
    isDrawing = true;
    // only count strokes that happen over the canvas
    if (mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height) {
      drewThisStroke = true;
    }
    stroke(255);
    strokeWeight(STROKE_WEIGHT);
    noFill();
    line(mouseX, mouseY, pmouseX, pmouseY);
  } else {
    isDrawing = false;
  }

  // Update canvas description dynamically based on drawing state
  describeElement(
    inputCanvas.elt,
    isDrawing
      ? 'Drawing in progress on the sketch canvas.'
      : 'Sketch canvas. Draw white lines, or upload your own image, then click Transfer.',
    LABEL
  );
}

function mouseReleased() {
  // First time the user finishes drawing something on the canvas,
  // highlight the generate button so they know what to do next.
  if (drewThisStroke && !firstSketchDone) {
    firstSketchDone = true;
    if (transferBtn && transferBtn.elt) {
      transferBtn.elt.classList.add('nudge');
      // remove the animation after it plays a few times so it isn't forever
      setTimeout(() => {
        if (transferBtn && transferBtn.elt) {
          transferBtn.elt.classList.remove('nudge');
        }
      }, 6000);
    }
  }
  drewThisStroke = false;
}

function beginModelLoad(message) {
  clearTimeout(modelLoadTimeoutId);
  modelReady = false;
  transferBtn.attribute('disabled', '');
  statusMsg.html(message);

  modelLoadTimeoutId = setTimeout(() => {
    if (!modelReady) {
      statusMsg.html('');
    }
  }, 8000);
}

function loadBundledModel() {
  // ml5 comes from a CDN; if it didn't load, say so clearly instead of hanging.
  if (typeof ml5 === 'undefined') {
    statusMsg.html('Could not reach the ml5 library. Check your internet connection and reload.');
    return;
  }

  beginModelLoad('');

  if (currentModelUrl) {
    URL.revokeObjectURL(currentModelUrl);
    currentModelUrl = null;
  }

  pix2pix = ml5.pix2pix(BUNDLED_MODEL_PATH, modelLoaded);
}

function handleModelFile(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;

  // Clean up any previously created object URL.
  if (currentModelUrl) {
    URL.revokeObjectURL(currentModelUrl);
    currentModelUrl = null;
  }

  beginModelLoad('Loading model... Please wait...');

  currentModelUrl = URL.createObjectURL(file);
  pix2pix = ml5.pix2pix(currentModelUrl, modelLoaded);
}

function handleImageFile(evt) {
  const file = evt.target.files && evt.target.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  loadImage(url, img => {
    background(0);
    image(img, 0, 0, DISPLAY, DISPLAY);
    inputImg = img;
    URL.revokeObjectURL(url);
  }, err => {
    console.log(err);
    statusMsg.html('Could not load that image file.');
    URL.revokeObjectURL(url);
  });
}

function modelLoaded() {
  clearTimeout(modelLoadTimeoutId);
  modelReady = true;
  statusMsg.html('Model Loaded!');
  transferBtn.elt.removeAttribute('disabled');
}

function clearCanvas() {
  statusMsg.html(modelReady ? 'Model loaded — draw a leaf and hit Transfer.' : 'Loading the model…');
  background(0);
  output.elt.src = '';
  output.elt.alt = 'The AI-generated output will appear here after clicking Transfer.';
}

function transfer() {
  if (!pix2pix || !modelReady) {
    statusMsg.html('The model is not ready yet — give it a moment to load.');
    return;
  }

  statusMsg.html('Transferring...');
  output.elt.alt = 'Generating AI image from your sketch, please wait.';

  modelCanvas.image(get(), 0, 0, SIZE, SIZE);

  pix2pix.transfer(modelCanvas.elt, function(err, result) {
    if (err) { console.log(err); return; }
    if (result && result.src) {
      statusMsg.html('generation done!');

      loadImage(result.src, p5img => {
        const tmp = createGraphics(DISPLAY, DISPLAY);
        tmp.pixelDensity(1);
        tmp.image(p5img, 0, 0, DISPLAY, DISPLAY);
        ditherFloydSteinbergColor(tmp);

        tmp.canvas.toBlob(blob => {
          output.elt.src = URL.createObjectURL(blob);
          output.elt.alt = 'AI-generated image produced from your line drawing. A color-dithered image based on the sketch you drew.';
        });
      });
    }
  });
}