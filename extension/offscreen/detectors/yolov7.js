// YOLOv7 (COCO, 80 classes) detector for TF.js.
//
// Detector contract (any future model implements the same shape):
//   id, version                 cache key components
//   load(tf)                    load weights + warm up, resolves when ready
//   classify(source, w, h)      source is any CanvasImageSource (ImageBitmap,
//                               HTMLImageElement, canvas). Resolves to
//                               { top: {label, score} | null,
//                                 scores: {label: score},      // per-label max
//                                 detections: [{label, score, box:[x1,y1,x2,y2]}] }
//                               box coords are in source pixels.
//
// Model I/O (from model.json signature):
//   input  "images"   [1, 3, 640, 640] float32, RGB, 0..1, NCHW
//   output "Identity" [1, 25200, 85]   cx, cy, w, h (640-space px), objectness,
//                                      80 class probabilities (already sigmoid)
(function (root) {
  'use strict';

  const SIZE = 640;
  const PAD = 114;            // standard YOLO letterbox gray
  const SCORE_FLOOR = 0.05;   // below this a label is not reported at all
  const TOPK = 64;            // candidate rows pulled back from the GPU
  const MAX_DETECTIONS = 10;
  const IOU = 0.45;

  const LABELS = [
    'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
    'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat',
    'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack',
    'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball',
    'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket',
    'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
    'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair',
    'couch', 'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse',
    'remote', 'keyboard', 'cell phone', 'microwave', 'oven', 'toaster', 'sink',
    'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier',
    'toothbrush',
  ];

  let tf = null;
  let model = null;
  let canvas = null;
  let ctx = null;

  function iou(a, b) {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]);
    const y2 = Math.min(a[3], b[3]);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    return ua > 0 ? inter / ua : 0;
  }

  // Letterbox: keep aspect ratio, center, pad with gray. Returns the mapping
  // needed to project boxes back into source coordinates.
  function letterbox(source, sw, sh) {
    const scale = Math.min(SIZE / sw, SIZE / sh);
    const nw = Math.round(sw * scale);
    const nh = Math.round(sh * scale);
    const dx = Math.floor((SIZE - nw) / 2);
    const dy = Math.floor((SIZE - nh) / 2);
    ctx.fillStyle = `rgb(${PAD},${PAD},${PAD})`;
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, sw, sh, dx, dy, nw, nh);
    return { scale, dx, dy };
  }

  async function runModel(input) {
    try {
      return model.execute(input);
    } catch (e) {
      // Graphs with dynamic ops need the async executor.
      return model.executeAsync(input);
    }
  }

  const detector = {
    id: 'yolov7-coco',
    version: 1,
    labels: LABELS,
    inputSize: SIZE,

    async load(tfLib, modelUrl) {
      tf = tfLib;
      canvas = document.createElement('canvas');
      canvas.width = SIZE;
      canvas.height = SIZE;
      ctx = canvas.getContext('2d', { willReadFrequently: false });
      model = await tf.loadGraphModel(modelUrl);
      // Warm up: first execution compiles shaders and is several times slower.
      const dummy = tf.zeros([1, 3, SIZE, SIZE]);
      const out = await runModel(dummy);
      await out.data();
      tf.dispose([dummy, out]);
    },

    async classify(source, sw, sh) {
      const map = letterbox(source, sw, sh);
      const input = tf.tidy(() =>
        tf.browser.fromPixels(canvas)       // [640,640,3] int32 RGB
          .toFloat()
          .div(255)
          .transpose([2, 0, 1])              // HWC -> CHW
          .expandDims(0));                   // [1,3,640,640]
      const out = await runModel(input);
      // Decode on the GPU, pull back only small tensors.
      const [classMaxT, valuesT, rowClsT, boxesT] = tf.tidy(() => {
        const o = out.squeeze([0]);                        // [25200,85]
        const obj = o.slice([0, 4], [-1, 1]);              // [25200,1]
        const cls = o.slice([0, 5], [-1, -1]);             // [25200,80]
        const conf = cls.mul(obj);                          // objectness x class prob
        const classMax = conf.max(0);                       // [80]
        const rowBest = conf.max(1);                        // [25200]
        const rowCls = conf.argMax(1);                      // [25200]
        const { values, indices } = tf.topk(rowBest, TOPK);
        return [
          classMax,
          values,
          tf.gather(rowCls, indices),
          tf.gather(o.slice([0, 0], [-1, 4]), indices),     // cx,cy,w,h
        ];
      });
      const [classMax, values, rowCls, boxes] = await Promise.all(
        [classMaxT, valuesT, rowClsT, boxesT].map(t => t.data()));
      tf.dispose([input, out, classMaxT, valuesT, rowClsT, boxesT]);

      const scores = {};
      let top = null;
      for (let i = 0; i < classMax.length; i++) {
        const s = classMax[i];
        if (s < SCORE_FLOOR) { continue; }
        scores[LABELS[i]] = Math.round(s * 1000) / 1000;
        if (top === null || s > top.score) { top = { label: LABELS[i], score: s }; }
      }

      // Class-aware greedy NMS over the top-K rows (already score-sorted).
      const detections = [];
      for (let k = 0; k < values.length && detections.length < MAX_DETECTIONS; k++) {
        const score = values[k];
        if (score < SCORE_FLOOR) { break; }
        const cx = boxes[k * 4], cy = boxes[k * 4 + 1], w = boxes[k * 4 + 2], h = boxes[k * 4 + 3];
        const box = [
          (cx - w / 2 - map.dx) / map.scale,
          (cy - h / 2 - map.dy) / map.scale,
          (cx + w / 2 - map.dx) / map.scale,
          (cy + h / 2 - map.dy) / map.scale,
        ].map(v => Math.round(v));
        const label = LABELS[rowCls[k]];
        if (detections.some(d => d.label === label && iou(d.box, box) > IOU)) { continue; }
        detections.push({ label, score: Math.round(score * 1000) / 1000, box });
      }

      return { top, scores, detections };
    },
  };

  root.SafeDetectors = root.SafeDetectors || {};
  root.SafeDetectors[detector.id] = detector;
})(globalThis);
