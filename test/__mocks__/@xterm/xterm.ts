export class Terminal {
  loadAddon(): void {}
  open(): void {}
  write(): void {}
  onData(): { dispose(): void } { return { dispose() {} } }
  dispose(): void {}
}
