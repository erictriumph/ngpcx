// /scanner/progress.ts

const FRAMES = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"];

let frameIndex = 0;

export function nextFrame() {
  frameIndex = (frameIndex + 1) % FRAMES.length;
  return FRAMES[frameIndex];
}

export function renderStage(label: string, current: number, total: number, extra?: string) {
  const percent = total === 0 ? 0 : Math.floor((current / total) * 100);
  const barLength = 20;
  const filled = Math.floor((percent / 100) * barLength);
  const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
  const spinner = nextFrame();

  const suffix = extra ? ` (${extra})` : "";

  process.stdout.write(
    `\r${label} ${spinner}  [${bar}] ${percent}%${suffix}   `
  );
}

export function endStage() {
  process.stdout.write("\n");
}
