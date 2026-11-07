# GuiTerminal

A graphical terminal for macOS, Windows and Linux: real terminals (zsh, bash,
PowerShell, CMD, `ssh`) with a GUI around them — tabs, a connection sidebar,
themes. You get the power of a real shell inside a desktop app you control.

Built with Electron + React + xterm.js + node-pty.

## Features

- **Real terminals** — every tab is a true PTY: `vim`, `htop`, `tmux`, `ssh` all work.
- **Tabs** — `Cmd/Ctrl+T` new tab, `Cmd/Ctrl+W` close, click to switch.
- **Sidebar** — one click to open zsh / bash / sh, or connect to any host in
  your `~/.ssh/config` (uses the system `ssh`, so keys, agents and ProxyJump
  keep working).
- **Live tab titles** via OSC 0/2 (shells that report their cwd/command update the tab).
- Clean dark theme, SF Mono on macOS.

## Development

Requirements: [Bun](https://bun.sh), Node 18+, Xcode CLT (macOS).

```sh
bun install
bun run start          # build + launch
bun run check          # typecheck
```

First install notes (bun skips postinstall scripts):

```sh
node node_modules/electron/install.js     # download the Electron binary
cd node_modules/node-pty && npx node-gyp rebuild --runtime=electron \
  --target=39.8.10 --dist-url=https://electronjs.org/headers && cd ../..
```

## Architecture

```
src/main/       Electron main process
  index.ts      window, menu, IPC, ssh-config parser
  pty.ts        PtyManager — owns every shell process
  preload.ts    contextBridge API for the renderer
src/renderer/   React UI (App: tabs+sidebar, TerminalPane: xterm.js)
src/shared/     types shared by both processes
scripts/build.ts  Bun bundler (renderer → dist/ui, main → dist/*.cjs)
```

Data flow: keyboard → xterm.js → IPC → node-pty → shell, and back up.
SSH tabs launch `/usr/bin/ssh -t <host>` inside the same PTY.

## Verify (CI-ish)

```sh
GT_VERIFY=1 npx electron .    # types a command through the real PTY,
                              # checks it renders in xterm, prints GT_VERIFY lines
GT_SCREENSHOT=/tmp/shot.png npx electron .   # self-capture for visual checks
```

## Roadmap

- Split panes, SFTP browser, saved connections beyond ssh-config
- tmux control mode (tmux windows as GUI tabs, iTerm2-style)
- Themes/settings screen

## License

MIT — © Rogerio Santos
