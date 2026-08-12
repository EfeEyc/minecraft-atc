
        // --- GLOBAL ERROR LOGGING & DIAGNOSTICS ---
        (function() {
            const oldError = console.error;
            const oldLog = console.log;
            const oldWarn = console.warn;

            async function sendToServer(type, message) {
                try {
                    await fetch('/client_log', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ type: type, message: message })
                    });
                } catch (e) {
                    oldError.call(console, "Failed to send log to server:", e);
                }
            }

            window.onerror = function(message, source, lineno, colno, error) {
                const errMsg = `${message} at ${source}:${lineno}:${colno}`;
                oldError.call(console, "UNHANDLED ERROR:", errMsg);
                sendToServer('UNHANDLED_ERROR', errMsg);
                return false;
            };

            window.addEventListener('unhandledrejection', function(event) {
                const reason = String(event.reason);
                oldError.call(console, "UNHANDLED REJECTION:", reason);
                sendToServer('UNHANDLED_REJECTION', reason);
            });

            function formatArg(x) {
                if (x === null) return 'null';
                if (x === undefined) return 'undefined';
                if (x instanceof Error) {
                    return `${x.name || 'Error'}: ${x.message}\nStack: ${x.stack || 'No stack'}`;
                }
                if (typeof x === 'object') {
                    if (x.message || x.stack) {
                        return `${x.name || 'Error'}: ${x.message}\nStack: ${x.stack || 'No stack'}`;
                    }
                    try { return JSON.stringify(x); } catch(e) { return String(x); }
                }
                return String(x);
            }

            console.log = function() {
                oldLog.apply(console, arguments);
                const msg = Array.from(arguments).map(formatArg).join(' ');
                sendToServer('LOG', msg);
            };

            console.error = function() {
                oldError.apply(console, arguments);
                const msg = Array.from(arguments).map(formatArg).join(' ');
                sendToServer('ERROR', msg);
            };

            console.warn = function() {
                oldWarn.apply(console, arguments);
                const msg = Array.from(arguments).map(formatArg).join(' ');
                sendToServer('WARN', msg);
            };

            console.log("Telemetry and error logger initialized.");
        })();

        // --- DIAGNOSTIC STATUS POLL ---
        setInterval(() => {
            const statusEl = document.getElementById('connection-status');
            if (statusEl && statusEl.innerText.startsWith('Connecting')) {
                statusEl.innerText = `Connecting to RCON telemetry... [bluemap: ${!!window.bluemap}, BlueMap: ${!!window.BlueMap}, Three: ${!!(window.BlueMap && window.BlueMap.Three)}, THREE: ${!!window.THREE}]`;
            }
        }, 500);
    
