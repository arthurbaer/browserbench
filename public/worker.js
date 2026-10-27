// CPU-Last: Integer-Hash + Float-Math + Sortierung, läuft ms Millisekunden
onmessage = e => {
  const ms = e.data.ms, arr = new Float64Array(256);
  let n = 0, x = 1, acc = 0;
  const end = performance.now() + ms;
  while (performance.now() < end) {
    for (let i = 0; i < 20000; i++) { x = (Math.imul(x, 1664525) + 1013904223) | 0; acc += Math.sqrt(Math.abs(x)) * Math.sin(i); arr[i & 255] = acc; }
    arr.sort(); n++;
  }
  postMessage({ ops: n * 20000, acc });
};
