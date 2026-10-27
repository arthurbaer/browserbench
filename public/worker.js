// CPU-Last: Integer-Hash + Float-Math + Sortierung, läuft ms Millisekunden; meldet alle ~150 ms die aktuelle Rate (Iterationen/ms)
onmessage = e => {
  const ms = e.data.ms, arr = new Float64Array(256);
  let n = 0, lastN = 0, x = 1, acc = 0, now, last = performance.now();
  const end = last + ms;
  while ((now = performance.now()) < end) {
    for (let i = 0; i < 20000; i++) { x = (Math.imul(x, 1664525) + 1013904223) | 0; acc += Math.sqrt(Math.abs(x)) * Math.sin(i); arr[i & 255] = acc; }
    arr.sort(); n++;
    if (now - last >= 150) { postMessage({ r: (n - lastN) * 20000 / (now - last) }); last = now; lastN = n; }
  }
  postMessage({ ops: n * 20000, acc });
};
