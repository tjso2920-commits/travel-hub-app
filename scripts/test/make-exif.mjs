/** 검사용 EXIF JPEG 생성기. GPS 와 촬영 시각을 담은 최소 JPEG 을 만든다. */
export function makeExifJpeg({ lat, lng, date = '2026:10:26 19:42:11' } = {}) {
  const entries = [];
  const push = (arr, tag, type, cnt, valOrOff) => arr.push({ tag, type, cnt, valOrOff });

  const dms = (v) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const m = Math.floor((a - d) * 60);
    const s = Math.round((((a - d) * 60) - m) * 60 * 100);
    return [[d, 1], [m, 1], [s, 100]];
  };

  // 가변 데이터 영역을 뒤에 붙이고 오프셋으로 참조한다
  const heap = [];
  let heapBase = 0;
  const addHeap = (bytes) => { const at = heapBase + heap.reduce((a, b) => a + b.length, 0); heap.push(bytes); return at; };
  const ratBytes = (rats) => { const b = Buffer.alloc(rats.length * 8); rats.forEach((r, i) => { b.writeUInt32LE(r[0], i * 8); b.writeUInt32LE(r[1], i * 8 + 4); }); return b; };
  const strBytes = (s) => Buffer.from(s + '\0', 'ascii');

  const hasGps = Number.isFinite(lat) && Number.isFinite(lng);
  // IFD0: ExifPtr(0x8769), GPSPtr(0x8825)
  const ifd0Count = hasGps ? 2 : 1;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const exifCount = 1;
  const exifSize = 2 + exifCount * 12 + 4;
  const gpsCount = hasGps ? 4 : 0;
  const gpsSize = hasGps ? 2 + gpsCount * 12 + 4 : 0;

  const ifd0Off = 8;
  const exifOff = ifd0Off + ifd0Size;
  const gpsOff = exifOff + exifSize;
  heapBase = gpsOff + gpsSize;

  const dateOff = addHeap(strBytes(date));
  let latOff = 0, lngOff = 0, nRefInline = 0, eRefInline = 0;
  if (hasGps) {
    latOff = addHeap(ratBytes(dms(lat)));
    lngOff = addHeap(ratBytes(dms(lng)));
    // EXIF 규격: 4바이트 이하 값은 오프셋이 아니라 항목 안에 그대로 담는다.
    // 실제 카메라도 이렇게 쓰므로 검사도 같아야 한다.
    nRefInline = (lat >= 0 ? 'N' : 'S').charCodeAt(0);
    eRefInline = (lng >= 0 ? 'E' : 'W').charCodeAt(0);
  }

  const heapBuf = Buffer.concat(heap);
  const tiff = Buffer.alloc(heapBase + heapBuf.length);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0Off, 4);

  const writeIFD = (off, list, next = 0) => {
    tiff.writeUInt16LE(list.length, off);
    list.forEach((e, i) => {
      const p = off + 2 + i * 12;
      tiff.writeUInt16LE(e.tag, p);
      tiff.writeUInt16LE(e.type, p + 2);
      tiff.writeUInt32LE(e.cnt, p + 4);
      tiff.writeUInt32LE(e.valOrOff, p + 8);
    });
    tiff.writeUInt32LE(next, off + 2 + list.length * 12);
  };

  const ifd0 = [];
  push(ifd0, 0x8769, 4, 1, exifOff);
  if (hasGps) push(ifd0, 0x8825, 4, 1, gpsOff);
  writeIFD(ifd0Off, ifd0);

  writeIFD(exifOff, [{ tag: 0x9003, type: 2, cnt: date.length + 1, valOrOff: dateOff }]);

  if (hasGps) {
    writeIFD(gpsOff, [
      { tag: 0x0001, type: 2, cnt: 2, valOrOff: nRefInline },
      { tag: 0x0002, type: 5, cnt: 3, valOrOff: latOff },
      { tag: 0x0003, type: 2, cnt: 2, valOrOff: eRefInline },
      { tag: 0x0004, type: 5, cnt: 3, valOrOff: lngOff }
    ]);
  }
  heapBuf.copy(tiff, heapBase);

  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xFFE1, 0);
  app1.writeUInt16BE(exifPayload.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    app1, exifPayload,
    Buffer.from([0xFF, 0xD9])
  ]);
}
