# Third-party materials

The MIT license in this repository covers Safe's original source, documentation,
icons and generated texture fixtures. It does not relicense dependencies, trained
models or downloaded photographs. These materials are kept outside Git.

## Runtime dependencies

- **TensorFlow.js 4.22.0**, including its WebGPU backend, is provided by the
  TensorFlow authors under [Apache-2.0](https://github.com/tensorflow/tfjs/blob/tfjs-v4.22.0/LICENSE).
  The vendoring script preserves the JavaScript license headers and includes the
  Apache license in `extension/vendor/`.
- The **YOLOv7 TensorFlow.js graph and weights** are downloaded from
  [Parker at revision 3a5510a](https://github.com/oxedom/parker/tree/3a5510ab36a8252ceaa82c3dcd95572bc253902a/client/public/yolov7_web_model).
  Parker publishes an [MIT license](https://github.com/oxedom/parker/blob/3a5510ab36a8252ceaa82c3dcd95572bc253902a/LICENSE.txt).
  The original [YOLOv7 project](https://github.com/WongKinYiu/yolov7) publishes
  [GPL-3.0 terms](https://github.com/WongKinYiu/yolov7/blob/main/LICENSE.md).
  The converted weights do not carry a separate license statement establishing
  MIT-only terms. Safe makes no such claim. The vendoring script includes both
  license texts with the model. Review the upstream model terms before
  redistributing a built extension; the repository's MIT license does not grant
  additional rights to those weights.

## Optional test photographs

`pnpm run setup:fixtures` downloads public object-detection samples for local
testing. Neither the originals nor their resized derivatives are committed.

| Local fixtures | Upstream source |
| --- | --- |
| `bus.jpg`, `zidane.jpg` and their resized variants | [Ultralytics YOLOv5 sample images at revision 1e7cf74](https://github.com/ultralytics/yolov5/tree/1e7cf74cb64d719b34f7315aa13eab9e32cde672/data/images) |
| `person.jpg`, `horses.jpg`, `eagle.jpg`, `giraffe.jpg`, `dog-bike-truck.jpg` and dog variants | [Darknet sample images at revision f6afaab](https://github.com/pjreddie/darknet/tree/f6afaabcdf85f77e7aff2ec55c020c0e297c77f9/data) |

Darknet publishes a [public-domain dedication](https://github.com/pjreddie/darknet/blob/f6afaabcdf85f77e7aff2ec55c020c0e297c77f9/LICENSE);
YOLOv5 publishes [AGPL-3.0 terms](https://github.com/ultralytics/yolov5/blob/1e7cf74cb64d719b34f7315aa13eab9e32cde672/LICENSE).
A repository's software license does not by itself establish the rights to every
photograph it hosts. Consult the original image owners before redistribution.
