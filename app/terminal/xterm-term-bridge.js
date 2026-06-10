/**
 * xterm-term-bridge.js — xterm.js terminal bridge for ios-linuxkit.
 *
 * Drop-in alternative to term.js (Ghostty). Uses the same native bridge API
 * (window.exports / webkit.messageHandlers) so the Obj-C host code doesn't
 * need changes — only the HTML entry point differs (xterm-term.html vs term.html).
 *
 * Build switch: in Terminal.m, load xterm-term.html instead of term.html to use
 * the xterm.js renderer instead of Ghostty WebGL/Canvas2D.
 */

(() => {
    'use strict';

    const { Terminal, FitAddon, WebLinksAddon } = window.xtermModules;

    // ── Native bridge (same as term.js) ──────────────────────────────────────
    const native = new Proxy({}, {
        get(_, prop) {
            return (body) => {
                try {
                    window.webkit.messageHandlers[prop].postMessage(body);
                } catch (e) {}
            };
        }
    });

    // ── Style state ──────────────────────────────────────────────────────────
    let styleState = {
        foregroundColor: '#d4d4d4',
        backgroundColor: '#1e1e1e',
        fontSize: 12,
        fontFamily: '"JetBrainsMono Nerd Font Mono", "FiraCode Nerd Font Mono", monospace',
        cursorShape: 'block',
    };

    // ── Terminal setup ────────────────────────────────────────────────────────
    const term = new Terminal({
        cols: 80,
        rows: 24,
        fontSize: styleState.fontSize,
        fontFamily: styleState.fontFamily,
        theme: {
            foreground: styleState.foregroundColor,
            background: styleState.backgroundColor,
            cursor: styleState.foregroundColor,
        },
        cursorBlink: true,
        allowTransparency: true,
        scrollback: 10000,
        convertEol: false,
        disableStdin: true,  // iOS handles text input natively
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());

    const container = document.getElementById('terminal');
    term.open(container);
    fitAddon.fit();

    // iPhone performance: cap pixel ratio
    const isIPhone = /iPhone/.test(navigator.userAgent);
    if (isIPhone) {
        term.options.devicePixelRatio = 1;
    }

    // ── Input → native ───────────────────────────────────────────────────────
    term.onData((data) => {
        native.sendInput(data);
    });

    // ── Resize handling ──────────────────────────────────────────────────────
    let resizeTimeout = null;
    function fitTerminal() {
        if (resizeTimeout) clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => {
            fitAddon.fit();
            native.resize({ cols: term.cols, rows: term.rows });
        }, 120);
    }

    const ro = new ResizeObserver(() => fitTerminal());
    ro.observe(container);

    // ── Scroll tracking ──────────────────────────────────────────────────────
    term.onScroll((scrollTop) => {
        native.newScrollTop(scrollTop);
    });

    // ── Exports (native → JS) ────────────────────────────────────────────────
    function latin1StringToBytes(str) {
        const bytes = new Uint8Array(str.length);
        for (let i = 0; i < str.length; i++) {
            bytes[i] = str.charCodeAt(i) & 0xff;
        }
        return bytes;
    }

    window.exports = {
        write(data) {
            if (typeof data === 'string') {
                term.write(latin1StringToBytes(data));
            } else {
                term.write(new Uint8Array(data));
            }
        },
        getSize() {
            return { cols: term.cols, rows: term.rows };
        },
        copy() {
            return term.getSelection();
        },
        setFocused(focused) {
            if (focused) term.focus();
            else term.blur();
        },
        scrollToBottom() {
            term.scrollToBottom();
        },
        newScrollTop(top) {
            term.scrollToLine(top);
        },
        updateStyle(newStyle) {
            Object.assign(styleState, newStyle);
            if (newStyle.fontSize) term.options.fontSize = newStyle.fontSize;
            if (newStyle.fontFamily) term.options.fontFamily = newStyle.fontFamily;
            if (newStyle.foregroundColor || newStyle.backgroundColor) {
                term.options.theme = {
                    foreground: styleState.foregroundColor,
                    background: styleState.backgroundColor,
                    cursor: styleState.foregroundColor,
                };
            }
            fitTerminal();
        },
        getCharacterSize() {
            const dims = term._core._renderService.dimensions;
            if (dims) {
                return { width: dims.css.cell.width, height: dims.css.cell.height };
            }
            return { width: styleState.fontSize * 0.6, height: styleState.fontSize * 1.2 };
        },
        clearScrollback() {
            term.clear();
        },
        setUserGesture() {},
        setAccessibilityEnabled() {},
    };

    // ── Signal ready ─────────────────────────────────────────────────────────
    fitTerminal();
    native.load(window.exports.getSize());
})();
