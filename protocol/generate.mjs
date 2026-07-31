// Generates the protocol bindings every service shares from protocol.json.
// Plain .mjs so it runs before any TypeScript build (it produces one of the
// build's inputs). Run with `npm run gen-protocol`; `npm run build` does it too.
//
// The spec describes a device: attributes (state) and commands (actions).
// Three shapes are derived from those rather than written by hand — State,
// WriteRequest and InvokeRequest — so a name cannot exist in one and not
// another.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_PATH = path.join(HERE, 'protocol.json');
const OUT_DIR = path.join(HERE, 'generated');

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));

const BANNER = [
  'Generated from protocol/protocol.json — do not edit by hand.',
  'Run `npm run gen-protocol` in church-media-server after changing the spec.',
];

const attributes = Object.entries(spec.attributes);
const writable = attributes.filter(([, attr]) => attr.access === 'rw');
const commands = Object.entries(spec.commands);

// --- shared helpers ---

/** Splits a spec type like `Flow?` or `string[]` into its parts */
function parseType(raw) {
  let type = raw;
  const nullable = type.endsWith('?');
  if (nullable) type = type.slice(0, -1);
  const array = type.endsWith('[]');
  if (array) type = type.slice(0, -2);
  return { base: type, array, nullable };
}

function pascal(name) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function screaming(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/** Wraps prose at a sensible width so generated comments stay readable */
function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// --- TypeScript ---

function tsType(raw) {
  const { base, array, nullable } = parseType(raw);
  const primitives = { string: 'string', number: 'number', boolean: 'boolean' };
  let out = primitives[base] ?? base;
  if (array) out = `${out}[]`;
  return nullable ? `${out} | null` : out;
}

function tsDoc(description, indent = '') {
  if (!description) return '';
  const lines = wrap(description, 84 - indent.length);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l}`).join('\n')}\n${indent} */`;
}

function tsFields(fields, indent) {
  return Object.entries(fields).flatMap(([name, field]) => {
    const doc = tsDoc(field.description, indent);
    const line = `${indent}${name}: ${tsType(field.type)};`;
    return doc ? [doc, line] : [line];
  });
}

/** Inline object literal type for a command's arguments */
function tsArgs(args) {
  if (!Object.keys(args).length) return 'Record<string, never>';
  return `{ ${Object.entries(args).map(([name, a]) => `${name}: ${tsType(a.type)}`).join('; ')} }`;
}

function generateTypeScript() {
  const out = [];
  out.push(BANNER.map((line) => `// ${line}`).join('\n'), '');
  out.push(tsDoc(spec.model), '');
  out.push(`export const PROTOCOL_VERSION = ${spec.version};`, '');

  for (const [name, def] of Object.entries(spec.enums)) {
    out.push(tsDoc(def.description));
    out.push(`export const ${name} = {`);
    out.push(...Object.entries(def.values).map(([key, value]) => `  ${key}: '${value}',`));
    out.push('} as const;');
    out.push(`export type ${name} = (typeof ${name})[keyof typeof ${name}];`);
    out.push(
      `export function is${name}(value: unknown): value is ${name} {`,
      `  return typeof value === 'string' && (Object.values(${name}) as string[]).includes(value);`,
      '}',
      '',
    );
  }

  for (const [name, def] of Object.entries(spec.types)) {
    out.push(tsDoc(def.description));
    out.push(`export interface ${name} {`, ...tsFields(def.fields, '  '), '}', '');
  }

  // --- attributes ---
  out.push('/** Every attribute this protocol defines, with how it may be used */');
  out.push('export const ATTRIBUTES = {');
  for (const [name, def] of attributes) {
    const parts = [`access: '${def.access}'`];
    if (def.permission) parts.push(`permission: '${def.permission}'`);
    if (def.range) parts.push(`range: { min: ${def.range.min}, max: ${def.range.max} }`);
    out.push(tsDoc(def.description, '  '));
    out.push(`  ${name}: { ${parts.join(', ')} },`);
  }
  out.push('} as const;');
  out.push('export type AttributeName = keyof typeof ATTRIBUTES;', '');

  out.push('/** Every command this protocol defines */');
  out.push('export const COMMANDS = {');
  for (const [name, def] of commands) {
    out.push(tsDoc(def.description, '  '));
    out.push(`  ${name}: { permission: '${def.permission ?? 'any'}' },`);
  }
  out.push('} as const;');
  out.push('export type CommandName = keyof typeof COMMANDS;', '');

  out.push('/** Attribute values. A state patch is any subset of these. */');
  out.push('export interface State {');
  for (const [name, def] of attributes) {
    out.push(tsDoc(def.description, '  '));
    out.push(`  ${name}: ${tsType(def.type)};`);
  }
  out.push('}');
  out.push('export type StatePatch = Partial<State>;', '');

  out.push('/** One write targets one attribute, so field and value stay in step. */');
  out.push('export type WriteRequest =');
  out.push(...writable.map(([name, def]) => `  | { field: '${name}'; value: ${tsType(def.type)} }`));
  out.push('  ;', '');

  out.push('/** One invoke runs one command, so command and args stay in step. */');
  out.push('export type InvokeRequest =');
  out.push(...commands.map(([name, def]) => `  | { command: '${name}'; args: ${tsArgs(def.args)} }`));
  out.push('  ;', '');

  // --- events ---
  for (const [direction, label] of [['c2s', 'C2S'], ['s2c', 'S2C']]) {
    const events = spec.events[direction];
    out.push(`/** ${label} event names */`);
    out.push(`export const ${label} = {`);
    out.push(...Object.keys(events).map((event) => `  ${screaming(event)}: '${event}',`));
    out.push('} as const;');
    out.push(`export type ${label}Event = (typeof ${label})[keyof typeof ${label}];`, '');

    out.push(`/** Payload carried by each ${label} event */`);
    out.push(`export interface ${label}Payloads {`);
    for (const [event, def] of Object.entries(events)) {
      out.push(tsDoc(def.description, '  '));
      if (def.payloadType) {
        out.push(`  ${event}: ${def.partial ? `${def.payloadType}Patch` : def.payloadType};`);
        continue;
      }
      const fields = tsFields(def.payload, '    ');
      if (!fields.length) {
        out.push(`  ${event}: Record<string, never>;`);
        continue;
      }
      out.push(`  ${event}: {`, ...fields, '  };');
    }
    out.push('}', '');
  }

  out.push(
    '/** Socket.IO map for clients: payloads are typed both ways */',
    'export type ClientToServerEvents = { [K in keyof C2SPayloads]: (payload: C2SPayloads[K]) => void };',
    'export type ServerToClientEvents = { [K in keyof S2CPayloads]: (payload: S2CPayloads[K]) => void };',
    '',
    '/**',
    ' * Server-side view of inbound events. Payloads arrive from untrusted clients,',
    ' * so handlers receive `unknown` and must narrow before use.',
    ' */',
    'export type ClientToServerEventsUnsafe = { [K in keyof C2SPayloads]: (payload: unknown) => void };',
    '',
  );

  return out.join('\n');
}

// --- Python ---

function pyType(raw) {
  const { base, array, nullable } = parseType(raw);
  const primitives = { string: 'str', number: 'float', boolean: 'bool' };
  let out = primitives[base] ?? base;
  if (array) out = `list[${out}]`;
  return nullable ? `${out} | None` : out;
}

function pyDoc(description, indent) {
  if (!description) return [];
  const lines = wrap(description, 78 - indent.length);
  if (lines.length === 1) return [`${indent}"""${lines[0]}"""`];
  return [`${indent}"""`, ...lines.map((l) => `${indent}${l}`), `${indent}"""`];
}

function pyFields(fields, indent) {
  const rows = Object.entries(fields).map(([name, field]) => {
    const comment = field.description ? `  # ${field.description}` : '';
    return `${indent}${name}: ${pyType(field.type)}${comment}`;
  });
  return rows.length ? rows : [`${indent}pass`];
}

function generatePython() {
  const out = [];
  out.push(BANNER.map((line) => `# ${line}`).join('\n'), '');
  out.push('from __future__ import annotations', '', 'from enum import Enum', 'from typing import TypedDict', '');
  out.push(...pyDoc(spec.model, ''));
  out.push('', `PROTOCOL_VERSION = ${spec.version}`);

  for (const [name, def] of Object.entries(spec.enums)) {
    out.push('', '', `class ${name}(str, Enum):`);
    out.push(...pyDoc(def.description, '    '));
    for (const [key, value] of Object.entries(def.values)) {
      out.push(`    ${key} = "${value}"`);
    }
  }

  for (const [name, def] of Object.entries(spec.types)) {
    out.push('', '', `class ${name}(TypedDict):`);
    out.push(...pyDoc(def.description, '    '));
    out.push(...pyFields(def.fields, '    '));
  }

  const attrFields = Object.fromEntries(attributes);
  out.push('', '', 'class State(TypedDict):');
  out.push('    """Attribute values, all present."""');
  out.push(...pyFields(attrFields, '    '));

  out.push('', '', 'class StatePatch(TypedDict, total=False):');
  out.push('    """Attributes that changed. Absent means unchanged."""');
  out.push(...pyFields(attrFields, '    '));

  out.push('', '', 'class WriteRequest(TypedDict):');
  out.push('    """One write targets one attribute. See ATTRIBUTES for the value type."""');
  out.push('    field: str');
  out.push('    value: object');

  for (const [name, def] of commands) {
    out.push('', '', `class ${pascal(name)}Args(TypedDict):`);
    out.push(...pyDoc(def.description, '    '));
    out.push(...pyFields(def.args, '    '));
  }

  out.push('', '', 'class InvokeRequest(TypedDict):');
  out.push('    """One invoke runs one command. See the *Args types for its arguments."""');
  out.push('    command: str');
  out.push('    args: dict');

  out.push('', '', 'ATTRIBUTES: dict[str, dict] = {');
  for (const [name, def] of attributes) {
    const parts = [`"access": "${def.access}"`];
    if (def.permission) parts.push(`"permission": "${def.permission}"`);
    if (def.range) parts.push(`"range": (${def.range.min}, ${def.range.max})`);
    out.push(`    "${name}": {${parts.join(', ')}},`);
  }
  out.push('}');

  out.push('', 'COMMANDS: dict[str, dict] = {');
  for (const [name, def] of commands) {
    out.push(`    "${name}": {"permission": "${def.permission ?? 'any'}"},`);
  }
  out.push('}');

  for (const [direction, label] of [['c2s', 'C2S'], ['s2c', 'S2C']]) {
    out.push('', '', `class ${label}(str, Enum):`);
    out.push(`    """${label} event names"""`);
    for (const event of Object.keys(spec.events[direction])) {
      out.push(`    ${screaming(event)} = "${event}"`);
    }
  }

  for (const direction of ['c2s', 's2c']) {
    for (const [event, def] of Object.entries(spec.events[direction])) {
      if (def.payloadType) continue; // reuses a type declared above
      out.push('', '', `class ${pascal(event)}Payload(TypedDict):`);
      out.push(...pyDoc(def.description, '    '));
      out.push(...pyFields(def.payload, '    '));
    }
  }

  out.push('');
  return out.join('\n');
}

// --- Markdown reference ---

function mdType(raw) {
  const { base, array, nullable } = parseType(raw);
  return `${base}${array ? '[]' : ''}${nullable ? ' \\| null' : ''}`;
}

function mdFieldTable(fields) {
  if (!Object.keys(fields).length) return ['_필드 없음._'];
  return [
    '| 필드 | 타입 | 설명 |',
    '| --- | --- | --- |',
    ...Object.entries(fields).map(
      ([name, field]) => `| \`${name}\` | \`${mdType(field.type)}\` | ${field.description ?? ''} |`,
    ),
  ];
}

const ACCESS_LABEL = { ro: '읽기 전용', rw: '읽기/쓰기' };

function generateMarkdown() {
  const out = [];
  out.push(`# 미디어 서버 프로토콜 v${spec.version}`, '');
  out.push(`> ${BANNER[0]}`, '');
  out.push(spec.description, '', spec.model, '');

  out.push('## 규칙', '');
  for (const rule of spec.conventions) out.push(`- ${rule}`);
  out.push('');

  out.push('## 연결 절차', '');
  out.push('1. 접속한 뒤 `hello`를 보냅니다 (기기 이름 + 프로토콜 버전).');
  out.push('2. 서버가 `ready`로 답합니다. `accepted`가 false면 버전이 맞지 않으므로 사용자에게 업데이트를 안내합니다.');
  out.push('3. `ready`의 `attributes`·`commands`에 없는 것은 이 서버가 지원하지 않으므로 화면에서 숨깁니다.');
  out.push('4. 이어서 서버가 전체 `state`를 보냅니다. 별도 조회 없이 화면을 그릴 수 있습니다.');
  out.push('5. 이후에는 `state` 패치를 받아 병합하기만 하면 됩니다.', '');

  out.push('## 속성 (읽고 쓰는 상태)', '');
  out.push('| 속성 | 타입 | 접근 | 권한 | 설명 |');
  out.push('| --- | --- | --- | --- | --- |');
  for (const [name, def] of attributes) {
    const range = def.range ? ` (${def.range.min}–${def.range.max})` : '';
    out.push(`| \`${name}\` | \`${mdType(def.type)}\`${range} | ${ACCESS_LABEL[def.access]} | ${def.permission ?? '—'} | ${def.description} |`);
  }
  out.push('');

  out.push('## 명령 (인자를 받는 동작)', '');
  for (const [name, def] of commands) {
    out.push(`### \`${name}\``, '');
    out.push(`권한: ${def.permission ?? 'any'}`, '');
    if (def.description) out.push(def.description, '');
    out.push(...mdFieldTable(def.args), '');
  }

  out.push('## 열거형', '');
  for (const [name, def] of Object.entries(spec.enums)) {
    out.push(`### ${name}`, '');
    if (def.description) out.push(def.description, '');
    out.push(Object.values(def.values).map((v) => `\`"${v}"\``).join(' · '), '');
  }

  out.push('## 객체', '');
  for (const [name, def] of Object.entries(spec.types)) {
    out.push(`### ${name}`, '');
    if (def.description) out.push(def.description, '');
    out.push(...mdFieldTable(def.fields), '');
  }

  for (const [direction, heading] of [['c2s', '클라이언트 → 서버'], ['s2c', '서버 → 클라이언트']]) {
    out.push(`## ${heading}`, '');
    for (const [event, def] of Object.entries(spec.events[direction])) {
      const scope = def.scope === 'reply' ? ' _(요청한 클라이언트에게만)_'
        : def.scope === 'broadcast' ? ' _(전체 브로드캐스트)_' : '';
      out.push(`### \`${event}\`${scope}`, '');
      if (def.description) out.push(def.description, '');
      if (def.payloadType === 'State') {
        out.push('페이로드: 바뀐 속성만 담은 패치. 위 속성 표를 참고하십시오.', '');
      } else if (def.payloadType === 'WriteRequest') {
        out.push('| 필드 | 타입 | 설명 |', '| --- | --- | --- |');
        out.push('| `field` | `AttributeName` | 쓰려는 속성 이름 |');
        out.push('| `value` | 속성에 따름 | 위 속성 표의 타입 |', '');
      } else if (def.payloadType === 'InvokeRequest') {
        out.push('| 필드 | 타입 | 설명 |', '| --- | --- | --- |');
        out.push('| `command` | `CommandName` | 실행할 명령 이름 |');
        out.push('| `args` | 명령에 따름 | 위 명령 절의 인자 |', '');
      } else {
        out.push(...mdFieldTable(def.payload), '');
      }
    }
  }

  return out.join('\n');
}

// --- write ---

fs.mkdirSync(OUT_DIR, { recursive: true });
const artifacts = [
  ['protocol.ts', generateTypeScript()],
  ['protocol.py', generatePython()],
  ['PROTOCOL.md', generateMarkdown()],
];

for (const [name, content] of artifacts) {
  fs.writeFileSync(path.join(OUT_DIR, name), content, 'utf8');
  console.log(`protocol: wrote generated/${name}`);
}
