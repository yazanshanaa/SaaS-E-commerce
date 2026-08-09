import net from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A minimal SMTP sink for the end-to-end suite.
 *
 * The acceptance bar is "a password reset email actually arrives" — which means the real mail
 * driver, the real template and a real SMTP conversation, not a stubbed sendMail(). In
 * development that destination is mailpit; here it is this, which speaks just enough SMTP for
 * nodemailer and writes every message it receives to a file the test can read.
 *
 * Deliberately no auth and no STARTTLS advertised: the dev SMTP config uses neither, so the
 * conversation exercised here is the one that runs in dev.
 */

export interface SmtpSink {
  port: number;
  file: string;
  stop: () => Promise<void>;
}

export async function startSmtpSink(port: number, file: string): Promise<SmtpSink> {
  const messages: string[] = [];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '[]', 'utf8');

  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = '';

    socket.setEncoding('utf8');
    socket.write('220 souq-sink ESMTP\r\n');

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            messages.push(current);
            current = '';
            writeFileSync(file, JSON.stringify(messages), 'utf8');
            socket.write('250 2.0.0 OK\r\n');
          } else {
            // Dot-stuffing: a line starting with '..' is an escaped '.'.
            current += `${line.startsWith('..') ? line.slice(1) : line}\n`;
          }
          index = buffer.indexOf('\r\n');
          continue;
        }

        const command = line.toUpperCase();
        if (command.startsWith('EHLO') || command.startsWith('HELO')) {
          socket.write('250-souq-sink\r\n250 8BITMIME\r\n');
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 OK\r\n');
        }

        index = buffer.indexOf('\r\n');
      }
    });

    socket.on('error', () => socket.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    port,
    file,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Decode a captured message enough to read it.
 *
 * Arabic subjects arrive as RFC 2047 encoded words and Arabic bodies as base64 or
 * quoted-printable, so a raw `includes()` on the wire format would find nothing and the test
 * would be asserting on noise.
 */
export function decodeMessage(raw: string): string {
  let decoded = raw;

  // RFC 2047 encoded words in headers: =?UTF-8?B?...?= and =?UTF-8?Q?...?=
  decoded = decoded.replace(/=\?[^?]+\?B\?([^?]+)\?=/gi, (_, b64: string) =>
    Buffer.from(b64, 'base64').toString('utf8'),
  );
  decoded = decoded.replace(/=\?[^?]+\?Q\?([^?]+)\?=/gi, (_, q: string) =>
    q.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    ),
  );

  // Base64 bodies: long runs of base64 characters on their own lines.
  decoded = decoded.replace(/(?:^[A-Za-z0-9+/=]{60,}\n)+/gm, (block) => {
    try {
      return `${Buffer.from(block.replace(/\n/g, ''), 'base64').toString('utf8')}\n`;
    } catch {
      return block;
    }
  });

  // Quoted-printable bodies.
  decoded = decoded
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (match, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 0x80 ? String.fromCharCode(code) : match;
    });

  return decoded;
}

/** Every absolute http(s) link in a decoded message. */
export function linksIn(decoded: string): string[] {
  return decoded.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
}
