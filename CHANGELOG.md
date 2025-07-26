# 0.1.0 (2025-07-26)


### Bug Fixes

* combine logs across multiple XML doc roots ([#26](https://github.com/commaai/qdl.js/issues/26)) ([b37eeff](https://github.com/commaai/qdl.js/commit/b37eeff809a3ec5a0360fc12806a611e23f90328))
* CRC32 is not hex ([#104](https://github.com/commaai/qdl.js/issues/104)) ([6ed889e](https://github.com/commaai/qdl.js/commit/6ed889ee01c9bcf32c765c9ebd2999feda25c5b8))
* **demo:** disable minify due to bug in bun build ([#18](https://github.com/commaai/qdl.js/issues/18)) ([8a80478](https://github.com/commaai/qdl.js/commit/8a804783957a9109f68ba3c6530e632c0203ed9c))
* **firehose:** add missing new keyword ([bef2477](https://github.com/commaai/qdl.js/commit/bef247749cbbe3b050d7071b6bdaed04726e23ee))
* **firehose:** onProgress can be undefined ([#29](https://github.com/commaai/qdl.js/issues/29)) ([cd1a74b](https://github.com/commaai/qdl.js/commit/cd1a74bb747b9c4def4475c435aa897fb866c11b))
* **firehose:** wait longer for slow responses ([#80](https://github.com/commaai/qdl.js/issues/80)) ([04bf80e](https://github.com/commaai/qdl.js/commit/04bf80e29c18e906659ea025657aef63de1bdc02)), closes [#65](https://github.com/commaai/qdl.js/issues/65)
* **flash:** correct sector offset for sparse chunks ([#110](https://github.com/commaai/qdl.js/issues/110)) ([32841e0](https://github.com/commaai/qdl.js/commit/32841e01406750302b33f47d9c4f918498401773))
* **gpt:** correctly convert GPTPartitionEntry to buffer ([#100](https://github.com/commaai/qdl.js/issues/100)) ([32e0a30](https://github.com/commaai/qdl.js/commit/32e0a3046d7544415653064cc016964eaf327f0d))
* more bigint type conversions ([#103](https://github.com/commaai/qdl.js/issues/103)) ([d6beb50](https://github.com/commaai/qdl.js/commit/d6beb50fc602507afe761d407761225786aa9db7))
* provide programmerUrl ([a815cb2](https://github.com/commaai/qdl.js/commit/a815cb2d1e7050532c7bf50b4eec3da9cb792c34))
* **qdl:** don't lookup "mbr" and "gpt" partition for eraseLun ([#106](https://github.com/commaai/qdl.js/issues/106)) ([d46f7ef](https://github.com/commaai/qdl.js/commit/d46f7efec2d621a0c3c05a7e7d40abb5c11dce4e))
* **qdl:** fixes for eraseLun ([#87](https://github.com/commaai/qdl.js/issues/87)) ([f8a25bc](https://github.com/commaai/qdl.js/commit/f8a25bc9f5d6e6cee4ef9227a31d3855b3c5c207))
* **qdl:** make programmerUrl a constructor arg ([d563c4d](https://github.com/commaai/qdl.js/commit/d563c4d500cc6f05d978dfab58d0a1989de96b72))
* **qdl:** move null check before use ([d77e030](https://github.com/commaai/qdl.js/commit/d77e0309a1d0bfc95284f190e2a2d96ef86df00a))
* **QDL:** setActiveSlot - update backup GPT ([#108](https://github.com/commaai/qdl.js/issues/108)) ([82aef0f](https://github.com/commaai/qdl.js/commit/82aef0f3086f70033b1b9aaf5247eb7ae2efa87d))
* **sahara:** get programmer file name from URL ([9cb1c77](https://github.com/commaai/qdl.js/commit/9cb1c774d62079329af8e29f4287b34ec9c5b5ed))
* **sparse:** bug in splitBlob handling split size ([#48](https://github.com/commaai/qdl.js/issues/48)) ([f5c01d0](https://github.com/commaai/qdl.js/commit/f5c01d0eb842e08b72bfcf505c051bf9c14fd93d))
* typo in qcserial unbind command ([#11](https://github.com/commaai/qdl.js/issues/11)) ([53f3920](https://github.com/commaai/qdl.js/commit/53f392068451acb0904c7bf920954de68becc3c1))
* **usblib:** check member not null before access ([765d0e6](https://github.com/commaai/qdl.js/commit/765d0e6dc0cda2f2e6785c37910ffdac5e93de73))
* **usblib:** prefix non-awaited async calls with 'void' ([b5fb28d](https://github.com/commaai/qdl.js/commit/b5fb28d7c2c82eb91e8750c494ed2a8a56559b7b))
* **usblib:** typo in vendorId/productId arg names ([0557850](https://github.com/commaai/qdl.js/commit/0557850e4f857eb840e37ef1d9f198a25def9e1b))
* use triple eq for string comparison ([96bcb81](https://github.com/commaai/qdl.js/commit/96bcb8160103a6bae8872c590d85a6757eed9525))
* **xmlparser:** typo in getResponse ([2cd59ab](https://github.com/commaai/qdl.js/commit/2cd59ab2cfbdfc932fc171780379e33456842a66))


### Features

* add device log message printing ([#93](https://github.com/commaai/qdl.js/issues/93)) ([aaf2326](https://github.com/commaai/qdl.js/commit/aaf2326537d36880db4326d8bf43c14dd19f4c12))
* add GPT repair functionality ([#91](https://github.com/commaai/qdl.js/issues/91)) ([c8c0464](https://github.com/commaai/qdl.js/commit/c8c04641f88110abcfe4414b3bd8cf264094a278))
* add QDL.js demo ([#7](https://github.com/commaai/qdl.js/issues/7)) ([bf73312](https://github.com/commaai/qdl.js/commit/bf733126edd6d31b79c84cd37f508af04c2dc3b4))
* **cli:** add printgpt command ([#82](https://github.com/commaai/qdl.js/issues/82)) ([bb3dac4](https://github.com/commaai/qdl.js/commit/bb3dac49825a1267ea7b8185f9c0af10ef321e3c))
* **cli:** print full primary and backup GPT ([#105](https://github.com/commaai/qdl.js/issues/105)) ([4214b39](https://github.com/commaai/qdl.js/commit/4214b39f1a239afbf3049efc1cc8c768f9c0de52))
* export CLI utilities ([#81](https://github.com/commaai/qdl.js/issues/81)) ([1ff8376](https://github.com/commaai/qdl.js/commit/1ff837671fbc6a8d9f489bca6403120a5a2dd439))
* export utils ([990fa9a](https://github.com/commaai/qdl.js/commit/990fa9ac8f49767e041996da7452c3ab46bbe92a))
* **flash:** optionally skip erasing before flashing sparse ([#112](https://github.com/commaai/qdl.js/issues/112)) ([52021f0](https://github.com/commaai/qdl.js/commit/52021f0b1ace58673ebca1fae740f6900ebff707))
* implement getstorageinfo ([#28](https://github.com/commaai/qdl.js/issues/28)) ([263c9df](https://github.com/commaai/qdl.js/commit/263c9df3d3f1c506763dbd125016689833b61aa0))
* **qdl:** prevent eraseLun if listed partitions not found ([#111](https://github.com/commaai/qdl.js/issues/111)) ([13a64c7](https://github.com/commaai/qdl.js/commit/13a64c79aa8c57494c01bdd93774ed58e34b6450))
* use qdl.js from the command line ([#69](https://github.com/commaai/qdl.js/issues/69)) ([7bbaae7](https://github.com/commaai/qdl.js/commit/7bbaae70e6bd589c8ec685928bdd7a79c5418119)), closes [#65](https://github.com/commaai/qdl.js/issues/65)



