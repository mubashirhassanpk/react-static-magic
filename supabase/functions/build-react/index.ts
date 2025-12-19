import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/wasm.js";
import { decompressSync } from "https://esm.sh/fflate@0.8.2";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Build logs storage
const buildLogs: string[] = [];

function log(message: string, type: "info" | "warn" | "error" = "info") {
  const timestamp = new Date().toISOString().substring(11, 19);
  const prefix = type === "error" ? "❌" : type === "warn" ? "⚠️" : "→";
  const logMessage = `[${timestamp}] ${prefix} ${message}`;
  buildLogs.push(logMessage);
  console.log(logMessage);
}

// Initialize esbuild WASM
let esbuildInitialized = false;
async function initEsbuild() {
  if (!esbuildInitialized) {
    log("Initializing esbuild WASM...");
    await esbuild.initialize({
      wasmURL: "https://deno.land/x/esbuild@v0.20.1/esbuild.wasm",
    });
    esbuildInitialized = true;
    log("esbuild initialized successfully");
  }
}

// Parse ZIP file and extract entries
function parseZip(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(data.buffer);
  
  let offset = 0;
  while (offset < data.length - 4) {
    const signature = view.getUint32(offset, true);
    
    if (signature !== 0x04034b50) {
      break;
    }
    
    const compressionMethod = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const fileNameLength = view.getUint16(offset + 26, true);
    const extraFieldLength = view.getUint16(offset + 28, true);
    
    const fileNameStart = offset + 30;
    const fileName = new TextDecoder().decode(
      data.slice(fileNameStart, fileNameStart + fileNameLength)
    );
    
    const dataStart = fileNameStart + fileNameLength + extraFieldLength;
    const compressedData = data.slice(dataStart, dataStart + compressedSize);
    
    if (!fileName.endsWith("/")) {
      let fileData: Uint8Array;
      if (compressionMethod === 8) {
        fileData = decompressSync(compressedData);
      } else if (compressionMethod === 0) {
        fileData = compressedData;
      } else {
        log(`Unsupported compression: ${compressionMethod} for ${fileName}`, "warn");
        fileData = new Uint8Array(0);
      }
      
      const normalizedName = fileName.replace(/^[^/]+\//, "");
      if (normalizedName) {
        files.set(normalizedName, fileData);
      }
    }
    
    offset = dataStart + compressedSize;
  }
  
  return files;
}

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parsePackageJson(files: Map<string, Uint8Array>): PackageJson | null {
  const content = files.get("package.json");
  if (!content) {
    log("No package.json found", "warn");
    return null;
  }
  
  try {
    const parsed = JSON.parse(new TextDecoder().decode(content)) as PackageJson;
    log(`Parsed package.json: ${parsed.name || "unnamed"}`);
    return parsed;
  } catch (e) {
    log(`Failed to parse package.json: ${e}`, "error");
    return null;
  }
}

function getDependencyVersion(dep: string, packageJson: PackageJson | null): string {
  const version = packageJson?.dependencies?.[dep] || packageJson?.devDependencies?.[dep];
  if (version) {
    return version.replace(/^[\^~><=]+/, "");
  }
  return "latest";
}

// Extract all used Tailwind classes from source files
function extractTailwindClasses(sourceFiles: Record<string, string>): Set<string> {
  const classes = new Set<string>();
  const classRegex = /className=["'`]([^"'`]+)["'`]/g;
  const clsxRegex = /(?:clsx|cn|twMerge)\s*\(\s*[^)]+\)/g;
  
  for (const code of Object.values(sourceFiles)) {
    // Extract className attributes
    let match;
    while ((match = classRegex.exec(code)) !== null) {
      match[1].split(/\s+/).forEach(cls => {
        if (cls && !cls.includes('{') && !cls.includes('$')) {
          classes.add(cls.trim());
        }
      });
    }
    
    // Extract from template literals and clsx calls
    const templateRegex = /`([^`]*)`/g;
    while ((match = templateRegex.exec(code)) !== null) {
      match[1].split(/\s+/).forEach(cls => {
        if (cls && !cls.includes('{') && !cls.includes('$') && /^[a-z]/.test(cls)) {
          classes.add(cls.trim());
        }
      });
    }
    
    // Extract string literals in arrays
    const stringArrayRegex = /["']([a-z][a-z0-9-:\/]+)["']/g;
    while ((match = stringArrayRegex.exec(code)) !== null) {
      if (match[1].includes('-') || match[1].includes(':')) {
        classes.add(match[1].trim());
      }
    }
  }
  
  return classes;
}

// Generate minimal Tailwind CSS based on used classes
function generateTailwindCSS(usedClasses: Set<string>, cssVars: string): string {
  const tailwindBase = `
/* Tailwind Base Reset */
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; }
html { line-height: 1.5; -webkit-text-size-adjust: 100%; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; line-height: inherit; }
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
a { color: inherit; text-decoration: inherit; }
button, input, select, textarea { font-family: inherit; font-size: 100%; margin: 0; padding: 0; }
button, [role="button"] { cursor: pointer; }
img, video { max-width: 100%; height: auto; display: block; }
* { --tw-ring-offset-width: 0px; --tw-ring-offset-color: #fff; --tw-ring-color: rgb(59 130 246 / 0.5); }
`;

  const utilities: Record<string, string> = {};
  
  // Layout
  utilities['container'] = '.container { width: 100%; margin-left: auto; margin-right: auto; padding-left: 1rem; padding-right: 1rem; }';
  utilities['block'] = '.block { display: block; }';
  utilities['inline-block'] = '.inline-block { display: inline-block; }';
  utilities['inline'] = '.inline { display: inline; }';
  utilities['flex'] = '.flex { display: flex; }';
  utilities['inline-flex'] = '.inline-flex { display: inline-flex; }';
  utilities['grid'] = '.grid { display: grid; }';
  utilities['hidden'] = '.hidden { display: none; }';
  
  // Flexbox
  utilities['flex-row'] = '.flex-row { flex-direction: row; }';
  utilities['flex-col'] = '.flex-col { flex-direction: column; }';
  utilities['flex-wrap'] = '.flex-wrap { flex-wrap: wrap; }';
  utilities['flex-nowrap'] = '.flex-nowrap { flex-wrap: nowrap; }';
  utilities['flex-1'] = '.flex-1 { flex: 1 1 0%; }';
  utilities['flex-auto'] = '.flex-auto { flex: 1 1 auto; }';
  utilities['flex-none'] = '.flex-none { flex: none; }';
  utilities['grow'] = '.grow { flex-grow: 1; }';
  utilities['grow-0'] = '.grow-0 { flex-grow: 0; }';
  utilities['shrink'] = '.shrink { flex-shrink: 1; }';
  utilities['shrink-0'] = '.shrink-0 { flex-shrink: 0; }';
  
  // Alignment
  utilities['items-start'] = '.items-start { align-items: flex-start; }';
  utilities['items-center'] = '.items-center { align-items: center; }';
  utilities['items-end'] = '.items-end { align-items: flex-end; }';
  utilities['items-baseline'] = '.items-baseline { align-items: baseline; }';
  utilities['items-stretch'] = '.items-stretch { align-items: stretch; }';
  utilities['justify-start'] = '.justify-start { justify-content: flex-start; }';
  utilities['justify-center'] = '.justify-center { justify-content: center; }';
  utilities['justify-end'] = '.justify-end { justify-content: flex-end; }';
  utilities['justify-between'] = '.justify-between { justify-content: space-between; }';
  utilities['justify-around'] = '.justify-around { justify-content: space-around; }';
  utilities['justify-evenly'] = '.justify-evenly { justify-content: space-evenly; }';
  
  // Spacing (margin, padding, gap)
  const spacingScale: Record<string, string> = {
    '0': '0px', '0.5': '0.125rem', '1': '0.25rem', '1.5': '0.375rem', '2': '0.5rem',
    '2.5': '0.625rem', '3': '0.75rem', '3.5': '0.875rem', '4': '1rem', '5': '1.25rem',
    '6': '1.5rem', '7': '1.75rem', '8': '2rem', '9': '2.25rem', '10': '2.5rem',
    '11': '2.75rem', '12': '3rem', '14': '3.5rem', '16': '4rem', '20': '5rem',
    '24': '6rem', '28': '7rem', '32': '8rem', '36': '9rem', '40': '10rem',
    '44': '11rem', '48': '12rem', '52': '13rem', '56': '14rem', '60': '15rem',
    '64': '16rem', '72': '18rem', '80': '20rem', '96': '24rem', 'px': '1px',
    'auto': 'auto', 'full': '100%', 'screen': '100vh'
  };
  
  for (const [key, value] of Object.entries(spacingScale)) {
    // Margin
    utilities[`m-${key}`] = `.m-${key.replace('.', '\\.')} { margin: ${value}; }`;
    utilities[`mx-${key}`] = `.mx-${key.replace('.', '\\.')} { margin-left: ${value}; margin-right: ${value}; }`;
    utilities[`my-${key}`] = `.my-${key.replace('.', '\\.')} { margin-top: ${value}; margin-bottom: ${value}; }`;
    utilities[`mt-${key}`] = `.mt-${key.replace('.', '\\.')} { margin-top: ${value}; }`;
    utilities[`mr-${key}`] = `.mr-${key.replace('.', '\\.')} { margin-right: ${value}; }`;
    utilities[`mb-${key}`] = `.mb-${key.replace('.', '\\.')} { margin-bottom: ${value}; }`;
    utilities[`ml-${key}`] = `.ml-${key.replace('.', '\\.')} { margin-left: ${value}; }`;
    // Padding
    utilities[`p-${key}`] = `.p-${key.replace('.', '\\.')} { padding: ${value}; }`;
    utilities[`px-${key}`] = `.px-${key.replace('.', '\\.')} { padding-left: ${value}; padding-right: ${value}; }`;
    utilities[`py-${key}`] = `.py-${key.replace('.', '\\.')} { padding-top: ${value}; padding-bottom: ${value}; }`;
    utilities[`pt-${key}`] = `.pt-${key.replace('.', '\\.')} { padding-top: ${value}; }`;
    utilities[`pr-${key}`] = `.pr-${key.replace('.', '\\.')} { padding-right: ${value}; }`;
    utilities[`pb-${key}`] = `.pb-${key.replace('.', '\\.')} { padding-bottom: ${value}; }`;
    utilities[`pl-${key}`] = `.pl-${key.replace('.', '\\.')} { padding-left: ${value}; }`;
    // Gap
    utilities[`gap-${key}`] = `.gap-${key.replace('.', '\\.')} { gap: ${value}; }`;
    utilities[`gap-x-${key}`] = `.gap-x-${key.replace('.', '\\.')} { column-gap: ${value}; }`;
    utilities[`gap-y-${key}`] = `.gap-y-${key.replace('.', '\\.')} { row-gap: ${value}; }`;
    // Width & Height
    utilities[`w-${key}`] = `.w-${key.replace('.', '\\.')} { width: ${value}; }`;
    utilities[`h-${key}`] = `.h-${key.replace('.', '\\.')} { height: ${value}; }`;
    utilities[`min-w-${key}`] = `.min-w-${key.replace('.', '\\.')} { min-width: ${value}; }`;
    utilities[`min-h-${key}`] = `.min-h-${key.replace('.', '\\.')} { min-height: ${value}; }`;
    utilities[`max-w-${key}`] = `.max-w-${key.replace('.', '\\.')} { max-width: ${value}; }`;
    utilities[`max-h-${key}`] = `.max-h-${key.replace('.', '\\.')} { max-height: ${value}; }`;
    // Inset
    utilities[`inset-${key}`] = `.inset-${key.replace('.', '\\.')} { inset: ${value}; }`;
    utilities[`top-${key}`] = `.top-${key.replace('.', '\\.')} { top: ${value}; }`;
    utilities[`right-${key}`] = `.right-${key.replace('.', '\\.')} { right: ${value}; }`;
    utilities[`bottom-${key}`] = `.bottom-${key.replace('.', '\\.')} { bottom: ${value}; }`;
    utilities[`left-${key}`] = `.left-${key.replace('.', '\\.')} { left: ${value}; }`;
    // Space between
    utilities[`space-x-${key}`] = `.space-x-${key.replace('.', '\\.')} > :not([hidden]) ~ :not([hidden]) { margin-left: ${value}; }`;
    utilities[`space-y-${key}`] = `.space-y-${key.replace('.', '\\.')} > :not([hidden]) ~ :not([hidden]) { margin-top: ${value}; }`;
  }
  
  // Additional width/height utilities
  utilities['w-1/2'] = '.w-1\\/2 { width: 50%; }';
  utilities['w-1/3'] = '.w-1\\/3 { width: 33.333333%; }';
  utilities['w-2/3'] = '.w-2\\/3 { width: 66.666667%; }';
  utilities['w-1/4'] = '.w-1\\/4 { width: 25%; }';
  utilities['w-3/4'] = '.w-3\\/4 { width: 75%; }';
  utilities['w-fit'] = '.w-fit { width: fit-content; }';
  utilities['w-min'] = '.w-min { width: min-content; }';
  utilities['w-max'] = '.w-max { width: max-content; }';
  utilities['h-fit'] = '.h-fit { height: fit-content; }';
  utilities['min-h-screen'] = '.min-h-screen { min-height: 100vh; }';
  utilities['max-w-xs'] = '.max-w-xs { max-width: 20rem; }';
  utilities['max-w-sm'] = '.max-w-sm { max-width: 24rem; }';
  utilities['max-w-md'] = '.max-w-md { max-width: 28rem; }';
  utilities['max-w-lg'] = '.max-w-lg { max-width: 32rem; }';
  utilities['max-w-xl'] = '.max-w-xl { max-width: 36rem; }';
  utilities['max-w-2xl'] = '.max-w-2xl { max-width: 42rem; }';
  utilities['max-w-3xl'] = '.max-w-3xl { max-width: 48rem; }';
  utilities['max-w-4xl'] = '.max-w-4xl { max-width: 56rem; }';
  utilities['max-w-5xl'] = '.max-w-5xl { max-width: 64rem; }';
  utilities['max-w-6xl'] = '.max-w-6xl { max-width: 72rem; }';
  utilities['max-w-7xl'] = '.max-w-7xl { max-width: 80rem; }';
  utilities['max-w-full'] = '.max-w-full { max-width: 100%; }';
  utilities['max-w-screen-sm'] = '.max-w-screen-sm { max-width: 640px; }';
  utilities['max-w-screen-md'] = '.max-w-screen-md { max-width: 768px; }';
  utilities['max-w-screen-lg'] = '.max-w-screen-lg { max-width: 1024px; }';
  utilities['max-w-screen-xl'] = '.max-w-screen-xl { max-width: 1280px; }';
  utilities['max-w-screen-2xl'] = '.max-w-screen-2xl { max-width: 1536px; }';
  
  // Typography
  utilities['text-xs'] = '.text-xs { font-size: 0.75rem; line-height: 1rem; }';
  utilities['text-sm'] = '.text-sm { font-size: 0.875rem; line-height: 1.25rem; }';
  utilities['text-base'] = '.text-base { font-size: 1rem; line-height: 1.5rem; }';
  utilities['text-lg'] = '.text-lg { font-size: 1.125rem; line-height: 1.75rem; }';
  utilities['text-xl'] = '.text-xl { font-size: 1.25rem; line-height: 1.75rem; }';
  utilities['text-2xl'] = '.text-2xl { font-size: 1.5rem; line-height: 2rem; }';
  utilities['text-3xl'] = '.text-3xl { font-size: 1.875rem; line-height: 2.25rem; }';
  utilities['text-4xl'] = '.text-4xl { font-size: 2.25rem; line-height: 2.5rem; }';
  utilities['text-5xl'] = '.text-5xl { font-size: 3rem; line-height: 1; }';
  utilities['text-6xl'] = '.text-6xl { font-size: 3.75rem; line-height: 1; }';
  utilities['text-7xl'] = '.text-7xl { font-size: 4.5rem; line-height: 1; }';
  utilities['text-8xl'] = '.text-8xl { font-size: 6rem; line-height: 1; }';
  utilities['text-9xl'] = '.text-9xl { font-size: 8rem; line-height: 1; }';
  
  utilities['font-thin'] = '.font-thin { font-weight: 100; }';
  utilities['font-extralight'] = '.font-extralight { font-weight: 200; }';
  utilities['font-light'] = '.font-light { font-weight: 300; }';
  utilities['font-normal'] = '.font-normal { font-weight: 400; }';
  utilities['font-medium'] = '.font-medium { font-weight: 500; }';
  utilities['font-semibold'] = '.font-semibold { font-weight: 600; }';
  utilities['font-bold'] = '.font-bold { font-weight: 700; }';
  utilities['font-extrabold'] = '.font-extrabold { font-weight: 800; }';
  utilities['font-black'] = '.font-black { font-weight: 900; }';
  
  utilities['text-left'] = '.text-left { text-align: left; }';
  utilities['text-center'] = '.text-center { text-align: center; }';
  utilities['text-right'] = '.text-right { text-align: right; }';
  utilities['text-justify'] = '.text-justify { text-align: justify; }';
  
  utilities['uppercase'] = '.uppercase { text-transform: uppercase; }';
  utilities['lowercase'] = '.lowercase { text-transform: lowercase; }';
  utilities['capitalize'] = '.capitalize { text-transform: capitalize; }';
  utilities['normal-case'] = '.normal-case { text-transform: none; }';
  
  utilities['italic'] = '.italic { font-style: italic; }';
  utilities['not-italic'] = '.not-italic { font-style: normal; }';
  
  utilities['underline'] = '.underline { text-decoration-line: underline; }';
  utilities['overline'] = '.overline { text-decoration-line: overline; }';
  utilities['line-through'] = '.line-through { text-decoration-line: line-through; }';
  utilities['no-underline'] = '.no-underline { text-decoration-line: none; }';
  
  utilities['tracking-tighter'] = '.tracking-tighter { letter-spacing: -0.05em; }';
  utilities['tracking-tight'] = '.tracking-tight { letter-spacing: -0.025em; }';
  utilities['tracking-normal'] = '.tracking-normal { letter-spacing: 0; }';
  utilities['tracking-wide'] = '.tracking-wide { letter-spacing: 0.025em; }';
  utilities['tracking-wider'] = '.tracking-wider { letter-spacing: 0.05em; }';
  utilities['tracking-widest'] = '.tracking-widest { letter-spacing: 0.1em; }';
  
  utilities['leading-none'] = '.leading-none { line-height: 1; }';
  utilities['leading-tight'] = '.leading-tight { line-height: 1.25; }';
  utilities['leading-snug'] = '.leading-snug { line-height: 1.375; }';
  utilities['leading-normal'] = '.leading-normal { line-height: 1.5; }';
  utilities['leading-relaxed'] = '.leading-relaxed { line-height: 1.625; }';
  utilities['leading-loose'] = '.leading-loose { line-height: 2; }';
  
  utilities['whitespace-normal'] = '.whitespace-normal { white-space: normal; }';
  utilities['whitespace-nowrap'] = '.whitespace-nowrap { white-space: nowrap; }';
  utilities['whitespace-pre'] = '.whitespace-pre { white-space: pre; }';
  utilities['whitespace-pre-line'] = '.whitespace-pre-line { white-space: pre-line; }';
  utilities['whitespace-pre-wrap'] = '.whitespace-pre-wrap { white-space: pre-wrap; }';
  
  utilities['truncate'] = '.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }';
  utilities['text-ellipsis'] = '.text-ellipsis { text-overflow: ellipsis; }';
  utilities['text-clip'] = '.text-clip { text-overflow: clip; }';
  
  // Colors - using CSS variables and common colors
  const colors: Record<string, string> = {
    'transparent': 'transparent', 'current': 'currentColor',
    'black': '#000', 'white': '#fff',
    'slate-50': '#f8fafc', 'slate-100': '#f1f5f9', 'slate-200': '#e2e8f0', 'slate-300': '#cbd5e1',
    'slate-400': '#94a3b8', 'slate-500': '#64748b', 'slate-600': '#475569', 'slate-700': '#334155',
    'slate-800': '#1e293b', 'slate-900': '#0f172a', 'slate-950': '#020617',
    'gray-50': '#f9fafb', 'gray-100': '#f3f4f6', 'gray-200': '#e5e7eb', 'gray-300': '#d1d5db',
    'gray-400': '#9ca3af', 'gray-500': '#6b7280', 'gray-600': '#4b5563', 'gray-700': '#374151',
    'gray-800': '#1f2937', 'gray-900': '#111827', 'gray-950': '#030712',
    'zinc-50': '#fafafa', 'zinc-100': '#f4f4f5', 'zinc-200': '#e4e4e7', 'zinc-300': '#d4d4d8',
    'zinc-400': '#a1a1aa', 'zinc-500': '#71717a', 'zinc-600': '#52525b', 'zinc-700': '#3f3f46',
    'zinc-800': '#27272a', 'zinc-900': '#18181b', 'zinc-950': '#09090b',
    'red-50': '#fef2f2', 'red-100': '#fee2e2', 'red-200': '#fecaca', 'red-300': '#fca5a5',
    'red-400': '#f87171', 'red-500': '#ef4444', 'red-600': '#dc2626', 'red-700': '#b91c1c',
    'red-800': '#991b1b', 'red-900': '#7f1d1d', 'red-950': '#450a0a',
    'orange-500': '#f97316', 'yellow-500': '#eab308', 'green-500': '#22c55e',
    'blue-50': '#eff6ff', 'blue-100': '#dbeafe', 'blue-200': '#bfdbfe', 'blue-300': '#93c5fd',
    'blue-400': '#60a5fa', 'blue-500': '#3b82f6', 'blue-600': '#2563eb', 'blue-700': '#1d4ed8',
    'blue-800': '#1e40af', 'blue-900': '#1e3a8a', 'blue-950': '#172554',
    'indigo-500': '#6366f1', 'purple-500': '#a855f7', 'pink-500': '#ec4899',
  };
  
  // Add semantic colors from CSS variables
  const semanticColors = ['background', 'foreground', 'card', 'card-foreground', 'primary', 'primary-foreground',
    'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground',
    'destructive', 'destructive-foreground', 'border', 'input', 'ring', 'popover', 'popover-foreground'];
  
  for (const name of semanticColors) {
    utilities[`bg-${name}`] = `.bg-${name} { background-color: hsl(var(--${name})); }`;
    utilities[`text-${name}`] = `.text-${name} { color: hsl(var(--${name})); }`;
    utilities[`border-${name}`] = `.border-${name} { border-color: hsl(var(--${name})); }`;
  }
  
  for (const [name, value] of Object.entries(colors)) {
    utilities[`bg-${name}`] = `.bg-${name} { background-color: ${value}; }`;
    utilities[`text-${name}`] = `.text-${name} { color: ${value}; }`;
    utilities[`border-${name}`] = `.border-${name} { border-color: ${value}; }`;
    utilities[`fill-${name}`] = `.fill-${name} { fill: ${value}; }`;
    utilities[`stroke-${name}`] = `.stroke-${name} { stroke: ${value}; }`;
  }
  
  // Opacity
  for (const opacity of [0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100]) {
    utilities[`opacity-${opacity}`] = `.opacity-${opacity} { opacity: ${opacity / 100}; }`;
    utilities[`bg-opacity-${opacity}`] = `.bg-opacity-${opacity} { --tw-bg-opacity: ${opacity / 100}; }`;
  }
  
  // Position
  utilities['static'] = '.static { position: static; }';
  utilities['fixed'] = '.fixed { position: fixed; }';
  utilities['absolute'] = '.absolute { position: absolute; }';
  utilities['relative'] = '.relative { position: relative; }';
  utilities['sticky'] = '.sticky { position: sticky; }';
  
  utilities['inset-0'] = '.inset-0 { inset: 0px; }';
  utilities['inset-x-0'] = '.inset-x-0 { left: 0px; right: 0px; }';
  utilities['inset-y-0'] = '.inset-y-0 { top: 0px; bottom: 0px; }';
  utilities['top-0'] = '.top-0 { top: 0px; }';
  utilities['right-0'] = '.right-0 { right: 0px; }';
  utilities['bottom-0'] = '.bottom-0 { bottom: 0px; }';
  utilities['left-0'] = '.left-0 { left: 0px; }';
  
  // Z-index
  for (const z of [0, 10, 20, 30, 40, 50]) {
    utilities[`z-${z}`] = `.z-${z} { z-index: ${z}; }`;
  }
  utilities['z-auto'] = '.z-auto { z-index: auto; }';
  
  // Overflow
  utilities['overflow-auto'] = '.overflow-auto { overflow: auto; }';
  utilities['overflow-hidden'] = '.overflow-hidden { overflow: hidden; }';
  utilities['overflow-visible'] = '.overflow-visible { overflow: visible; }';
  utilities['overflow-scroll'] = '.overflow-scroll { overflow: scroll; }';
  utilities['overflow-x-auto'] = '.overflow-x-auto { overflow-x: auto; }';
  utilities['overflow-y-auto'] = '.overflow-y-auto { overflow-y: auto; }';
  utilities['overflow-x-hidden'] = '.overflow-x-hidden { overflow-x: hidden; }';
  utilities['overflow-y-hidden'] = '.overflow-y-hidden { overflow-y: hidden; }';
  
  // Border
  utilities['border'] = '.border { border-width: 1px; }';
  utilities['border-0'] = '.border-0 { border-width: 0px; }';
  utilities['border-2'] = '.border-2 { border-width: 2px; }';
  utilities['border-4'] = '.border-4 { border-width: 4px; }';
  utilities['border-8'] = '.border-8 { border-width: 8px; }';
  utilities['border-t'] = '.border-t { border-top-width: 1px; }';
  utilities['border-r'] = '.border-r { border-right-width: 1px; }';
  utilities['border-b'] = '.border-b { border-bottom-width: 1px; }';
  utilities['border-l'] = '.border-l { border-left-width: 1px; }';
  
  utilities['border-solid'] = '.border-solid { border-style: solid; }';
  utilities['border-dashed'] = '.border-dashed { border-style: dashed; }';
  utilities['border-dotted'] = '.border-dotted { border-style: dotted; }';
  utilities['border-double'] = '.border-double { border-style: double; }';
  utilities['border-none'] = '.border-none { border-style: none; }';
  
  // Border radius
  utilities['rounded-none'] = '.rounded-none { border-radius: 0px; }';
  utilities['rounded-sm'] = '.rounded-sm { border-radius: 0.125rem; }';
  utilities['rounded'] = '.rounded { border-radius: 0.25rem; }';
  utilities['rounded-md'] = '.rounded-md { border-radius: 0.375rem; }';
  utilities['rounded-lg'] = '.rounded-lg { border-radius: 0.5rem; }';
  utilities['rounded-xl'] = '.rounded-xl { border-radius: 0.75rem; }';
  utilities['rounded-2xl'] = '.rounded-2xl { border-radius: 1rem; }';
  utilities['rounded-3xl'] = '.rounded-3xl { border-radius: 1.5rem; }';
  utilities['rounded-full'] = '.rounded-full { border-radius: 9999px; }';
  utilities['rounded-t-lg'] = '.rounded-t-lg { border-top-left-radius: 0.5rem; border-top-right-radius: 0.5rem; }';
  utilities['rounded-b-lg'] = '.rounded-b-lg { border-bottom-left-radius: 0.5rem; border-bottom-right-radius: 0.5rem; }';
  
  // Shadow
  utilities['shadow-sm'] = '.shadow-sm { box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05); }';
  utilities['shadow'] = '.shadow { box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1); }';
  utilities['shadow-md'] = '.shadow-md { box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1); }';
  utilities['shadow-lg'] = '.shadow-lg { box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1); }';
  utilities['shadow-xl'] = '.shadow-xl { box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1); }';
  utilities['shadow-2xl'] = '.shadow-2xl { box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25); }';
  utilities['shadow-inner'] = '.shadow-inner { box-shadow: inset 0 2px 4px 0 rgb(0 0 0 / 0.05); }';
  utilities['shadow-none'] = '.shadow-none { box-shadow: 0 0 #0000; }';
  
  // Ring
  utilities['ring'] = '.ring { --tw-ring-offset-shadow: 0 0 #0000; --tw-ring-shadow: 0 0 0 3px var(--tw-ring-color); box-shadow: var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow, 0 0 #0000); }';
  utilities['ring-0'] = '.ring-0 { --tw-ring-shadow: 0 0 0 0px var(--tw-ring-color); }';
  utilities['ring-1'] = '.ring-1 { --tw-ring-shadow: 0 0 0 1px var(--tw-ring-color); }';
  utilities['ring-2'] = '.ring-2 { --tw-ring-shadow: 0 0 0 2px var(--tw-ring-color); }';
  utilities['ring-offset-2'] = '.ring-offset-2 { --tw-ring-offset-width: 2px; }';
  
  // Transitions
  utilities['transition'] = '.transition { transition-property: color, background-color, border-color, text-decoration-color, fill, stroke, opacity, box-shadow, transform, filter, backdrop-filter; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }';
  utilities['transition-all'] = '.transition-all { transition-property: all; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }';
  utilities['transition-colors'] = '.transition-colors { transition-property: color, background-color, border-color, text-decoration-color, fill, stroke; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }';
  utilities['transition-opacity'] = '.transition-opacity { transition-property: opacity; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }';
  utilities['transition-transform'] = '.transition-transform { transition-property: transform; transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); transition-duration: 150ms; }';
  utilities['transition-none'] = '.transition-none { transition-property: none; }';
  
  utilities['duration-75'] = '.duration-75 { transition-duration: 75ms; }';
  utilities['duration-100'] = '.duration-100 { transition-duration: 100ms; }';
  utilities['duration-150'] = '.duration-150 { transition-duration: 150ms; }';
  utilities['duration-200'] = '.duration-200 { transition-duration: 200ms; }';
  utilities['duration-300'] = '.duration-300 { transition-duration: 300ms; }';
  utilities['duration-500'] = '.duration-500 { transition-duration: 500ms; }';
  utilities['duration-700'] = '.duration-700 { transition-duration: 700ms; }';
  utilities['duration-1000'] = '.duration-1000 { transition-duration: 1000ms; }';
  
  utilities['ease-linear'] = '.ease-linear { transition-timing-function: linear; }';
  utilities['ease-in'] = '.ease-in { transition-timing-function: cubic-bezier(0.4, 0, 1, 1); }';
  utilities['ease-out'] = '.ease-out { transition-timing-function: cubic-bezier(0, 0, 0.2, 1); }';
  utilities['ease-in-out'] = '.ease-in-out { transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1); }';
  
  // Transform
  utilities['transform'] = '.transform { transform: var(--tw-transform); }';
  utilities['scale-0'] = '.scale-0 { --tw-scale-x: 0; --tw-scale-y: 0; transform: translate(var(--tw-translate-x), var(--tw-translate-y)) rotate(var(--tw-rotate)) skewX(var(--tw-skew-x)) skewY(var(--tw-skew-y)) scaleX(var(--tw-scale-x)) scaleY(var(--tw-scale-y)); }';
  utilities['scale-50'] = '.scale-50 { --tw-scale-x: .5; --tw-scale-y: .5; transform: scale(.5); }';
  utilities['scale-75'] = '.scale-75 { transform: scale(.75); }';
  utilities['scale-90'] = '.scale-90 { transform: scale(.9); }';
  utilities['scale-95'] = '.scale-95 { transform: scale(.95); }';
  utilities['scale-100'] = '.scale-100 { transform: scale(1); }';
  utilities['scale-105'] = '.scale-105 { transform: scale(1.05); }';
  utilities['scale-110'] = '.scale-110 { transform: scale(1.1); }';
  utilities['scale-125'] = '.scale-125 { transform: scale(1.25); }';
  utilities['scale-150'] = '.scale-150 { transform: scale(1.5); }';
  
  utilities['rotate-0'] = '.rotate-0 { transform: rotate(0deg); }';
  utilities['rotate-45'] = '.rotate-45 { transform: rotate(45deg); }';
  utilities['rotate-90'] = '.rotate-90 { transform: rotate(90deg); }';
  utilities['rotate-180'] = '.rotate-180 { transform: rotate(180deg); }';
  
  utilities['translate-x-0'] = '.translate-x-0 { transform: translateX(0); }';
  utilities['translate-y-0'] = '.translate-y-0 { transform: translateY(0); }';
  utilities['translate-x-1/2'] = '.translate-x-1\\/2 { transform: translateX(50%); }';
  utilities['translate-y-1/2'] = '.translate-y-1\\/2 { transform: translateY(50%); }';
  utilities['-translate-x-1/2'] = '.-translate-x-1\\/2 { transform: translateX(-50%); }';
  utilities['-translate-y-1/2'] = '.-translate-y-1\\/2 { transform: translateY(-50%); }';
  
  // Animations
  utilities['animate-none'] = '.animate-none { animation: none; }';
  utilities['animate-spin'] = '.animate-spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }';
  utilities['animate-ping'] = '.animate-ping { animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite; } @keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }';
  utilities['animate-pulse'] = '.animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; } @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }';
  utilities['animate-bounce'] = '.animate-bounce { animation: bounce 1s infinite; } @keyframes bounce { 0%, 100% { transform: translateY(-25%); animation-timing-function: cubic-bezier(0.8, 0, 1, 1); } 50% { transform: translateY(0); animation-timing-function: cubic-bezier(0, 0, 0.2, 1); } }';
  
  // Cursor
  utilities['cursor-auto'] = '.cursor-auto { cursor: auto; }';
  utilities['cursor-default'] = '.cursor-default { cursor: default; }';
  utilities['cursor-pointer'] = '.cursor-pointer { cursor: pointer; }';
  utilities['cursor-wait'] = '.cursor-wait { cursor: wait; }';
  utilities['cursor-text'] = '.cursor-text { cursor: text; }';
  utilities['cursor-move'] = '.cursor-move { cursor: move; }';
  utilities['cursor-not-allowed'] = '.cursor-not-allowed { cursor: not-allowed; }';
  
  // Pointer events
  utilities['pointer-events-none'] = '.pointer-events-none { pointer-events: none; }';
  utilities['pointer-events-auto'] = '.pointer-events-auto { pointer-events: auto; }';
  
  // User select
  utilities['select-none'] = '.select-none { user-select: none; }';
  utilities['select-text'] = '.select-text { user-select: text; }';
  utilities['select-all'] = '.select-all { user-select: all; }';
  utilities['select-auto'] = '.select-auto { user-select: auto; }';
  
  // Visibility
  utilities['visible'] = '.visible { visibility: visible; }';
  utilities['invisible'] = '.invisible { visibility: hidden; }';
  utilities['collapse'] = '.collapse { visibility: collapse; }';
  
  // Object fit
  utilities['object-contain'] = '.object-contain { object-fit: contain; }';
  utilities['object-cover'] = '.object-cover { object-fit: cover; }';
  utilities['object-fill'] = '.object-fill { object-fit: fill; }';
  utilities['object-none'] = '.object-none { object-fit: none; }';
  utilities['object-scale-down'] = '.object-scale-down { object-fit: scale-down; }';
  utilities['object-center'] = '.object-center { object-position: center; }';
  
  // Aspect ratio
  utilities['aspect-auto'] = '.aspect-auto { aspect-ratio: auto; }';
  utilities['aspect-square'] = '.aspect-square { aspect-ratio: 1 / 1; }';
  utilities['aspect-video'] = '.aspect-video { aspect-ratio: 16 / 9; }';
  
  // Grid
  utilities['grid-cols-1'] = '.grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }';
  utilities['grid-cols-2'] = '.grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }';
  utilities['grid-cols-3'] = '.grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }';
  utilities['grid-cols-4'] = '.grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }';
  utilities['grid-cols-5'] = '.grid-cols-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }';
  utilities['grid-cols-6'] = '.grid-cols-6 { grid-template-columns: repeat(6, minmax(0, 1fr)); }';
  utilities['grid-cols-12'] = '.grid-cols-12 { grid-template-columns: repeat(12, minmax(0, 1fr)); }';
  utilities['col-span-1'] = '.col-span-1 { grid-column: span 1 / span 1; }';
  utilities['col-span-2'] = '.col-span-2 { grid-column: span 2 / span 2; }';
  utilities['col-span-3'] = '.col-span-3 { grid-column: span 3 / span 3; }';
  utilities['col-span-4'] = '.col-span-4 { grid-column: span 4 / span 4; }';
  utilities['col-span-6'] = '.col-span-6 { grid-column: span 6 / span 6; }';
  utilities['col-span-12'] = '.col-span-12 { grid-column: span 12 / span 12; }';
  utilities['col-span-full'] = '.col-span-full { grid-column: 1 / -1; }';
  
  // Place content
  utilities['place-content-center'] = '.place-content-center { place-content: center; }';
  utilities['place-items-center'] = '.place-items-center { place-items: center; }';
  utilities['place-self-center'] = '.place-self-center { place-self: center; }';
  
  // Self alignment
  utilities['self-auto'] = '.self-auto { align-self: auto; }';
  utilities['self-start'] = '.self-start { align-self: flex-start; }';
  utilities['self-end'] = '.self-end { align-self: flex-end; }';
  utilities['self-center'] = '.self-center { align-self: center; }';
  utilities['self-stretch'] = '.self-stretch { align-self: stretch; }';

  // Backdrop
  utilities['backdrop-blur'] = '.backdrop-blur { backdrop-filter: blur(8px); }';
  utilities['backdrop-blur-sm'] = '.backdrop-blur-sm { backdrop-filter: blur(4px); }';
  utilities['backdrop-blur-md'] = '.backdrop-blur-md { backdrop-filter: blur(12px); }';
  utilities['backdrop-blur-lg'] = '.backdrop-blur-lg { backdrop-filter: blur(16px); }';
  utilities['backdrop-blur-xl'] = '.backdrop-blur-xl { backdrop-filter: blur(24px); }';
  
  // Filter
  utilities['blur'] = '.blur { filter: blur(8px); }';
  utilities['blur-sm'] = '.blur-sm { filter: blur(4px); }';
  utilities['blur-md'] = '.blur-md { filter: blur(12px); }';
  utilities['blur-lg'] = '.blur-lg { filter: blur(16px); }';
  utilities['blur-none'] = '.blur-none { filter: blur(0); }';
  
  // SR only
  utilities['sr-only'] = '.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0; }';
  utilities['not-sr-only'] = '.not-sr-only { position: static; width: auto; height: auto; padding: 0; margin: 0; overflow: visible; clip: auto; white-space: normal; }';
  
  // Outline
  utilities['outline-none'] = '.outline-none { outline: 2px solid transparent; outline-offset: 2px; }';
  utilities['outline'] = '.outline { outline-style: solid; }';
  utilities['outline-0'] = '.outline-0 { outline-width: 0px; }';
  utilities['outline-1'] = '.outline-1 { outline-width: 1px; }';
  utilities['outline-2'] = '.outline-2 { outline-width: 2px; }';

  // Build responsive variants
  const breakpoints = {
    'sm': '640px',
    'md': '768px',
    'lg': '1024px',
    'xl': '1280px',
    '2xl': '1536px'
  };

  // Collect used utilities
  let css = tailwindBase + '\n' + cssVars + '\n';
  
  for (const className of usedClasses) {
    // Check for responsive prefix
    const responsiveMatch = className.match(/^(sm|md|lg|xl|2xl):(.*)/);
    if (responsiveMatch) {
      const [, breakpoint, utility] = responsiveMatch;
      const baseUtility = utilities[utility];
      if (baseUtility && breakpoints[breakpoint as keyof typeof breakpoints]) {
        const escapedClassName = className.replace(':', '\\:').replace('/', '\\/').replace('.', '\\.');
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        css += `@media (min-width: ${breakpoints[breakpoint as keyof typeof breakpoints]}) { .${escapedClassName} { ${ruleBody} } }\n`;
      }
    }
    // Check for hover/focus prefix
    else if (className.startsWith('hover:')) {
      const utility = className.replace('hover:', '');
      const baseUtility = utilities[utility];
      if (baseUtility) {
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        const escapedClassName = className.replace(':', '\\:');
        css += `.${escapedClassName}:hover { ${ruleBody} }\n`;
      }
    }
    else if (className.startsWith('focus:')) {
      const utility = className.replace('focus:', '');
      const baseUtility = utilities[utility];
      if (baseUtility) {
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        const escapedClassName = className.replace(':', '\\:');
        css += `.${escapedClassName}:focus { ${ruleBody} }\n`;
      }
    }
    else if (className.startsWith('focus-visible:')) {
      const utility = className.replace('focus-visible:', '');
      const baseUtility = utilities[utility];
      if (baseUtility) {
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        const escapedClassName = className.replace(':', '\\:');
        css += `.${escapedClassName}:focus-visible { ${ruleBody} }\n`;
      }
    }
    else if (className.startsWith('active:')) {
      const utility = className.replace('active:', '');
      const baseUtility = utilities[utility];
      if (baseUtility) {
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        const escapedClassName = className.replace(':', '\\:');
        css += `.${escapedClassName}:active { ${ruleBody} }\n`;
      }
    }
    else if (className.startsWith('disabled:')) {
      const utility = className.replace('disabled:', '');
      const baseUtility = utilities[utility];
      if (baseUtility) {
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        const escapedClassName = className.replace(':', '\\:');
        css += `.${escapedClassName}:disabled { ${ruleBody} }\n`;
      }
    }
    else if (className.startsWith('dark:')) {
      const utility = className.replace('dark:', '');
      const baseUtility = utilities[utility];
      if (baseUtility) {
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        const escapedClassName = className.replace(':', '\\:');
        css += `.dark .${escapedClassName} { ${ruleBody} }\n`;
      }
    }
    else if (className.startsWith('group-hover:')) {
      const utility = className.replace('group-hover:', '');
      const baseUtility = utilities[utility];
      if (baseUtility) {
        const ruleBody = baseUtility.match(/\{([^}]+)\}/)?.[1] || '';
        const escapedClassName = className.replace(':', '\\:');
        css += `.group:hover .${escapedClassName} { ${ruleBody} }\n`;
      }
    }
    // Base utility
    else if (utilities[className]) {
      css += utilities[className] + '\n';
    }
  }
  
  return css;
}

// Transform code: handle path aliases, CSS imports, asset imports
function transformCode(
  code: string, 
  filePath: string,
  packageJson: PackageJson | null,
  allFiles: Map<string, Uint8Array>,
  sourceFiles: Record<string, string>
): { code: string; warnings: string[] } {
  const warnings: string[] = [];
  
  // Remove CSS imports (we'll handle CSS separately)
  code = code.replace(/import\s+['"][^'"]+\.css['"];?\n?/g, '');
  
  // Remove asset imports and replace with empty string or placeholder
  code = code.replace(/import\s+\w+\s+from\s+['"][^'"]+\.(png|jpg|jpeg|gif|svg|webp|ico)['"];?\n?/g, '');
  
  // Transform path aliases (@/ -> src/)
  code = code.replace(/from\s+['"]@\/([^'"]+)['"]/g, (match, path) => {
    return `from "src/${path}"`;
  });
  code = code.replace(/from\s+['"]~\/([^'"]+)['"]/g, (match, path) => {
    return `from "src/${path}"`;
  });
  
  // Get all dependencies
  const allDeps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };
  
  // Transform npm package imports to esm.sh
  const npmImportRegex = /from\s+['"]([^'"./][^'"]*)['"]/g;
  let match;
  while ((match = npmImportRegex.exec(code)) !== null) {
    const pkg = match[1];
    // Skip if already transformed
    if (pkg.startsWith('https://')) continue;
    
    const version = getDependencyVersion(pkg, packageJson);
    const cdnUrl = `https://esm.sh/${pkg}@${version}`;
    code = code.replace(new RegExp(`from\\s+['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`, 'g'), `from "${cdnUrl}"`);
  }
  
  return { code, warnings };
}

function generateHtml(jsFileName: string, cssFileName: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Built React App</title>
  <link rel="stylesheet" href="./${cssFileName}">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./${jsFileName}"></script>
</body>
</html>`;
}

function generateInlineHtml(bundledJs: string, bundledCss: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Built React App</title>
  <style>
${bundledCss}
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
${bundledJs}
  </script>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  buildLogs.length = 0;

  try {
    await initEsbuild();
    
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { jobId } = await req.json();

    if (!jobId) {
      return new Response(
        JSON.stringify({ success: false, error: "Job ID is required", logs: buildLogs }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`Starting build job: ${jobId}`);

    const { data: job, error: jobError } = await supabase
      .from("build_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();

    if (jobError || !job) {
      log("Build job not found", "error");
      return new Response(
        JSON.stringify({ success: false, error: "Build job not found", logs: buildLogs }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("build_jobs").update({ status: "processing" }).eq("id", jobId);

    log(`Downloading input file: ${job.input_file_path}`);

    const { data: fileData, error: downloadError } = await supabase.storage
      .from("react-projects")
      .download(job.input_file_path);

    if (downloadError || !fileData) {
      log(`Failed to download file: ${downloadError?.message}`, "error");
      await supabase.from("build_jobs").update({ 
        status: "failed", 
        error_message: "Failed to download uploaded file",
        completed_at: new Date().toISOString()
      }).eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to download uploaded file", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`File downloaded, size: ${(fileData.size / 1024).toFixed(1)} KB`);

    const zipData = new Uint8Array(await fileData.arrayBuffer());
    let files: Map<string, Uint8Array>;
    
    try {
      files = parseZip(zipData);
      log(`Extracted ${files.size} files from ZIP`);
    } catch (zipError) {
      log(`Failed to parse ZIP: ${zipError}`, "error");
      await supabase.from("build_jobs").update({ 
        status: "failed", 
        error_message: "Failed to parse ZIP file.",
        completed_at: new Date().toISOString()
      }).eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to parse ZIP file", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log("Parsing package.json for dependencies...");
    const packageJson = parsePackageJson(files);
    
    if (packageJson) {
      const depCount = Object.keys(packageJson.dependencies || {}).length;
      const devDepCount = Object.keys(packageJson.devDependencies || {}).length;
      log(`Found ${depCount} dependencies and ${devDepCount} dev dependencies`);
    }

    const entryPoints = ["src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.jsx", "main.tsx", "main.jsx"];
    let entryPoint: string | null = null;
    
    for (const ep of entryPoints) {
      if (files.has(ep)) {
        entryPoint = ep;
        break;
      }
    }

    if (!entryPoint) {
      log("No entry point found", "error");
      await supabase.from("build_jobs").update({ 
        status: "failed", 
        error_message: "No entry point found (src/main.tsx, etc.)",
        completed_at: new Date().toISOString()
      }).eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "No entry point found", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`Found entry point: ${entryPoint}`);

    // Collect and transform source files
    const sourceFiles: Record<string, string> = {};
    let sourceFileCount = 0;
    
    for (const [path, content] of files) {
      if (path.endsWith(".tsx") || path.endsWith(".ts") || path.endsWith(".jsx") || path.endsWith(".js")) {
        const rawCode = new TextDecoder().decode(content);
        const { code } = transformCode(rawCode, path, packageJson, files, sourceFiles);
        sourceFiles[path] = code;
        sourceFileCount++;
      }
    }
    
    log(`Processing ${sourceFileCount} source files`);

    // Extract CSS variables from index.css if present
    let cssVars = "";
    const indexCss = files.get("src/index.css");
    if (indexCss) {
      const cssContent = new TextDecoder().decode(indexCss);
      // Extract :root and .dark CSS variable blocks
      const rootMatch = cssContent.match(/:root\s*\{[^}]+\}/g);
      const darkMatch = cssContent.match(/\.dark\s*\{[^}]+\}/g);
      if (rootMatch) cssVars += rootMatch.join('\n') + '\n';
      if (darkMatch) cssVars += darkMatch.join('\n') + '\n';
      log("Extracted CSS variables from index.css");
    }

    // Extract Tailwind classes and generate CSS
    log("Extracting Tailwind classes from source files...");
    const usedClasses = extractTailwindClasses(sourceFiles);
    log(`Found ${usedClasses.size} unique Tailwind classes`);
    
    const tailwindCss = generateTailwindCSS(usedClasses, cssVars);
    log(`Generated ${(tailwindCss.length / 1024).toFixed(1)} KB of Tailwind CSS`);

    // Collect additional CSS files (excluding index.css which we already processed)
    let additionalCss = "";
    let cssFileCount = 0;
    for (const [path, content] of files) {
      if (path.endsWith(".css") && path !== "src/index.css") {
        additionalCss += `/* ${path} */\n` + new TextDecoder().decode(content) + "\n\n";
        cssFileCount++;
      }
    }
    
    const combinedCss = tailwindCss + "\n" + additionalCss;
    log(`Total CSS: ${cssFileCount + 1} files processed`);

    // Bundle with esbuild
    log("Starting esbuild bundling...");
    let bundledJs = "";
    try {
      const virtualFs: esbuild.Plugin = {
        name: "virtual-fs",
        setup(build) {
          build.onResolve({ filter: /^\./ }, (args) => {
            const basedir = args.importer ? args.importer.replace(/\/[^/]+$/, "") : "";
            let resolved = `${basedir}/${args.path}`.replace(/\/+/g, "/").replace(/^\//, "");
            
            const extensions = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
            for (const ext of extensions) {
              const candidate = resolved + ext;
              if (sourceFiles[candidate]) {
                return { path: candidate, namespace: "virtual" };
              }
            }
            return { path: resolved, namespace: "virtual" };
          });
          
          build.onResolve({ filter: /^src\// }, (args) => {
            const extensions = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts"];
            for (const ext of extensions) {
              const candidate = args.path + ext;
              if (sourceFiles[candidate]) {
                return { path: candidate, namespace: "virtual" };
              }
            }
            return { path: args.path, namespace: "virtual" };
          });
          
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.path.startsWith("https://")) {
              return { path: args.path, external: true };
            }
            const version = getDependencyVersion(args.path, packageJson);
            return { path: `https://esm.sh/${args.path}@${version}`, external: true };
          });
          
          build.onLoad({ filter: /.*/, namespace: "virtual" }, (args) => {
            const content = sourceFiles[args.path];
            if (content) {
              const ext = args.path.split(".").pop() || "tsx";
              const loader = ["tsx", "ts", "jsx", "js"].includes(ext) ? ext as esbuild.Loader : "tsx";
              return { contents: content, loader };
            }
            return { contents: "", loader: "tsx" };
          });
        }
      };
      
      const reactVersion = getDependencyVersion("react", packageJson);
      
      const result = await esbuild.build({
        stdin: {
          contents: sourceFiles[entryPoint],
          loader: entryPoint.endsWith(".tsx") ? "tsx" : "jsx",
          resolveDir: entryPoint.includes("/") ? entryPoint.replace(/\/[^/]+$/, "") : ".",
        },
        bundle: true,
        format: "esm",
        target: "es2020",
        minify: true,
        write: false,
        plugins: [virtualFs],
        jsx: "automatic",
        jsxImportSource: `https://esm.sh/react@${reactVersion}`,
      });
      
      bundledJs = new TextDecoder().decode(result.outputFiles[0].contents);
      log(`Bundle complete: ${(bundledJs.length / 1024).toFixed(1)} KB (minified)`);
      
      for (const warning of result.warnings) {
        log(`esbuild: ${warning.text}`, "warn");
      }
    } catch (bundleError) {
      log(`Bundle error: ${bundleError}`, "error");
      const errorMessage = bundleError instanceof Error ? bundleError.message : "Unknown build error";
      await supabase.from("build_jobs").update({ 
        status: "failed", 
        error_message: `Build failed: ${errorMessage}`,
        completed_at: new Date().toISOString()
      }).eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: `Build failed: ${errorMessage}`, logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create ZIP file
    log("Creating ZIP archive with all assets...");
    
    const zipFiles: Record<string, Uint8Array> = {
      "index.html": strToU8(generateHtml("bundle.js", "styles.css")),
      "bundle.js": strToU8(bundledJs),
      "styles.css": strToU8(combinedCss),
    };
    
    // Include static assets
    let assetCount = 0;
    for (const [path, content] of files) {
      if (path.startsWith("public/") && !path.endsWith("/")) {
        const assetPath = path.replace("public/", "");
        zipFiles[assetPath] = content;
        assetCount++;
      }
    }
    
    if (assetCount > 0) {
      log(`Included ${assetCount} static assets`);
    }

    const outputZip = zipSync(zipFiles, { level: 9 });
    log(`ZIP created: ${(outputZip.length / 1024).toFixed(1)} KB`);

    const zipOutputPath = `${jobId}/build.zip`;
    log(`Uploading build.zip...`);

    const { error: zipUploadError } = await supabase.storage
      .from("static-builds")
      .upload(zipOutputPath, outputZip, {
        contentType: "application/zip",
        upsert: true
      });

    if (zipUploadError) {
      log(`Failed to upload ZIP: ${zipUploadError.message}`, "error");
    }

    const inlineHtml = generateInlineHtml(bundledJs, combinedCss);
    const htmlOutputPath = `${jobId}/index.html`;
    
    const { error: htmlUploadError } = await supabase.storage
      .from("static-builds")
      .upload(htmlOutputPath, new TextEncoder().encode(inlineHtml), {
        contentType: "text/html",
        upsert: true
      });

    if (htmlUploadError) {
      log(`Failed to upload preview HTML: ${htmlUploadError.message}`, "error");
      await supabase.from("build_jobs").update({ 
        status: "failed", 
        error_message: "Failed to save build output",
        completed_at: new Date().toISOString()
      }).eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to save build output", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    await supabase.from("build_jobs").update({ 
      status: "completed", 
      output_file_path: zipOutputPath,
      completed_at: new Date().toISOString()
    }).eq("id", jobId);

    const { data: zipUrlData } = supabase.storage.from("static-builds").getPublicUrl(zipOutputPath);
    const { data: previewUrlData } = supabase.storage.from("static-builds").getPublicUrl(htmlOutputPath);

    log("✅ Build completed successfully!");

    return new Response(
      JSON.stringify({ 
        success: true, 
        downloadUrl: zipUrlData.publicUrl,
        previewUrl: previewUrlData.publicUrl,
        message: "Build completed successfully",
        logs: buildLogs,
        stats: {
          filesProcessed: files.size,
          sourceFiles: sourceFileCount,
          cssFiles: cssFileCount + 1,
          bundleSize: bundledJs.length,
          cssSize: combinedCss.length,
          zipSize: outputZip.length,
          tailwindClasses: usedClasses.size,
          dependencies: Object.keys(packageJson?.dependencies || {}).length,
          devDependencies: Object.keys(packageJson?.devDependencies || {}).length,
        }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    log(`Unexpected error: ${error}`, "error");
    const errorMessage = error instanceof Error ? error.message : "Build failed";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage, logs: buildLogs }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
