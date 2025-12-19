import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { decompressSync } from "https://esm.sh/fflate@0.8.2";
import { zipSync, strToU8 } from "https://esm.sh/fflate@0.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const buildLogs: string[] = [];

function log(message: string, type: "info" | "warn" | "error" = "info") {
  const timestamp = new Date().toISOString().substring(11, 19);
  const prefix = type === "error" ? "❌" : type === "warn" ? "⚠️" : "→";
  const logMessage = `[${timestamp}] ${prefix} ${message}`;
  buildLogs.push(logMessage);
  console.log(logMessage);
}

// Simple TypeScript/JSX transformer using regex (fallback if SWC fails)
function simpleTransform(code: string, isTs: boolean, isJsx: boolean): string {
  // Remove TypeScript type annotations
  if (isTs) {
    // Remove type imports
    code = code.replace(/import\s+type\s+{[^}]+}\s+from\s+['"][^'"]+['"];?\n?/g, '');
    code = code.replace(/import\s+{[^}]*\btype\s+\w+[^}]*}\s+from/g, (match) => {
      return match.replace(/,?\s*type\s+\w+/g, '');
    });
    
    // Remove interface declarations
    code = code.replace(/interface\s+\w+\s*(<[^>]+>)?\s*(\{[\s\S]*?\n\})/g, '');
    
    // Remove type declarations
    code = code.replace(/type\s+\w+\s*(<[^>]+>)?\s*=\s*[^;]+;/g, '');
    
    // Remove type annotations from variables
    code = code.replace(/:\s*\w+(\[\])?\s*(<[^>]+>)?\s*=/g, ' =');
    code = code.replace(/:\s*\w+(\[\])?\s*(<[^>]+>)?\s*\)/g, ')');
    code = code.replace(/:\s*\w+(\[\])?\s*(<[^>]+>)?\s*,/g, ',');
    code = code.replace(/:\s*\w+(\[\])?\s*(<[^>]+>)?\s*\{/g, ' {');
    
    // Remove generic type parameters from functions
    code = code.replace(/<\w+(\s*,\s*\w+)*>\s*\(/g, '(');
    
    // Remove as assertions
    code = code.replace(/\s+as\s+\w+(\[\])?(<[^>]+>)?/g, '');
  }
  
  // Transform JSX (basic transformation)
  if (isJsx) {
    // This is a simplified JSX transform - for complex JSX, we rely on esm.sh doing the transform
    // We mainly just need to handle the imports
  }
  
  return code;
}

// Transform TypeScript/JSX to JavaScript
function transformCode(code: string, filename: string): string {
  const isTs = filename.endsWith('.ts') || filename.endsWith('.tsx');
  const isJsx = filename.endsWith('.jsx') || filename.endsWith('.tsx');
  
  try {
    // Try using simple transform first (most reliable in edge functions)
    return simpleTransform(code, isTs, isJsx);
  } catch (e) {
    log(`Transform warning for ${filename}: ${e}`, "warn");
    return code;
  }
}

function parseZip(data: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(data.buffer);
  
  let offset = 0;
  while (offset < data.length - 4) {
    const signature = view.getUint32(offset, true);
    
    if (signature !== 0x04034b50) break;
    
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
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages: string[] };
}

interface WorkspacePackage {
  name: string;
  path: string;
  packageJson: PackageJson;
  entryPoint: string | null;
}

interface MonorepoInfo {
  isMonorepo: boolean;
  rootPackageJson: PackageJson | null;
  packages: WorkspacePackage[];
  allDependencies: Record<string, string>;
}

function parsePackageJsonAt(files: Map<string, Uint8Array>, path: string): PackageJson | null {
  const content = files.get(path);
  if (!content) return null;
  
  try {
    return JSON.parse(new TextDecoder().decode(content)) as PackageJson;
  } catch (e) {
    return null;
  }
}

function parsePackageJson(files: Map<string, Uint8Array>): PackageJson | null {
  const parsed = parsePackageJsonAt(files, "package.json");
  if (parsed) {
    log(`Parsed package.json: ${parsed.name || "unnamed"}`);
  } else {
    log("No package.json found", "warn");
  }
  return parsed;
}

function detectMonorepo(files: Map<string, Uint8Array>): MonorepoInfo {
  const rootPackageJson = parsePackageJsonAt(files, "package.json");
  const result: MonorepoInfo = {
    isMonorepo: false,
    rootPackageJson,
    packages: [],
    allDependencies: {}
  };
  
  if (!rootPackageJson) return result;
  
  let workspacePatterns: string[] = [];
  
  if (rootPackageJson.workspaces) {
    if (Array.isArray(rootPackageJson.workspaces)) {
      workspacePatterns = rootPackageJson.workspaces;
    } else if (rootPackageJson.workspaces.packages) {
      workspacePatterns = rootPackageJson.workspaces.packages;
    }
  }
  
  const pnpmWorkspace = files.get("pnpm-workspace.yaml");
  if (pnpmWorkspace) {
    const content = new TextDecoder().decode(pnpmWorkspace);
    const packagesMatch = content.match(/packages:\s*\n((?:\s+-\s*.+\n?)+)/);
    if (packagesMatch) {
      const patterns = packagesMatch[1].split('\n')
        .map(line => line.replace(/^\s+-\s*['"]?([^'"]+)['"]?\s*$/, '$1').trim())
        .filter(p => p);
      workspacePatterns.push(...patterns);
    }
  }
  
  if (workspacePatterns.length === 0) {
    result.allDependencies = {
      ...rootPackageJson.dependencies,
      ...rootPackageJson.devDependencies
    };
    return result;
  }
  
  result.isMonorepo = true;
  log(`Detected monorepo with patterns: ${workspacePatterns.join(", ")}`);
  
  result.allDependencies = {
    ...rootPackageJson.dependencies,
    ...rootPackageJson.devDependencies
  };
  
  const allPaths = Array.from(files.keys());
  const packageJsonPaths = allPaths.filter(p => p.endsWith("package.json") && p !== "package.json");
  
  for (const pkgPath of packageJsonPaths) {
    const dirPath = pkgPath.replace("/package.json", "");
    
    const matches = workspacePatterns.some(pattern => {
      const regexPattern = pattern.replace(/\*/g, "[^/]+").replace(/\*\*/g, ".*");
      return new RegExp(`^${regexPattern}$`).test(dirPath);
    });
    
    if (matches) {
      const pkgJson = parsePackageJsonAt(files, pkgPath);
      if (pkgJson) {
        const entryPoints = [
          `${dirPath}/src/main.tsx`, `${dirPath}/src/main.jsx`,
          `${dirPath}/src/index.tsx`, `${dirPath}/src/index.jsx`,
        ];
        
        let entryPoint: string | null = null;
        for (const ep of entryPoints) {
          if (files.has(ep)) {
            entryPoint = ep;
            break;
          }
        }
        
        result.packages.push({
          name: pkgJson.name || dirPath,
          path: dirPath,
          packageJson: pkgJson,
          entryPoint
        });
        
        result.allDependencies = {
          ...result.allDependencies,
          ...pkgJson.dependencies,
          ...pkgJson.devDependencies
        };
        
        log(`Found workspace package: ${pkgJson.name || dirPath}`);
      }
    }
  }
  
  result.packages.sort((a, b) => {
    const aIsApp = a.path.includes("app") || a.entryPoint !== null;
    const bIsApp = b.path.includes("app") || b.entryPoint !== null;
    if (aIsApp && !bIsApp) return -1;
    if (!aIsApp && bIsApp) return 1;
    return a.path.localeCompare(b.path);
  });
  
  return result;
}

function getDependencyVersion(dep: string, packageJson: PackageJson | null, allDeps?: Record<string, string>): string {
  if (allDeps && allDeps[dep]) {
    return allDeps[dep].replace(/^[\^~><=]+/, "").replace(/^workspace:\*?/, "");
  }
  const version = packageJson?.dependencies?.[dep] || packageJson?.devDependencies?.[dep];
  if (version) {
    if (version.startsWith("workspace:")) return "latest";
    return version.replace(/^[\^~><=]+/, "");
  }
  return "latest";
}

// Extract Tailwind classes from source files
function extractTailwindClasses(sourceFiles: Record<string, string>): Set<string> {
  const classes = new Set<string>();
  const classRegex = /className=["'`]([^"'`]+)["'`]/g;
  
  for (const code of Object.values(sourceFiles)) {
    let match;
    while ((match = classRegex.exec(code)) !== null) {
      match[1].split(/\s+/).forEach(cls => {
        if (cls && !cls.includes('{') && !cls.includes('$')) {
          classes.add(cls.trim());
        }
      });
    }
    
    const templateRegex = /`([^`]*)`/g;
    while ((match = templateRegex.exec(code)) !== null) {
      match[1].split(/\s+/).forEach(cls => {
        if (cls && !cls.includes('{') && !cls.includes('$') && /^[a-z]/.test(cls)) {
          classes.add(cls.trim());
        }
      });
    }
  }
  
  return classes;
}

// Generate Tailwind CSS (simplified version)
function generateTailwindCSS(usedClasses: Set<string>, cssVars: string): string {
  const tailwindBase = `
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; }
html { line-height: 1.5; -webkit-text-size-adjust: 100%; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; line-height: inherit; }
h1, h2, h3, h4, h5, h6 { font-size: inherit; font-weight: inherit; }
a { color: inherit; text-decoration: inherit; }
button, input, select, textarea { font-family: inherit; font-size: 100%; margin: 0; padding: 0; }
button, [role="button"] { cursor: pointer; }
img, video { max-width: 100%; height: auto; display: block; }
`;

  const utilities: Record<string, string> = {
    'flex': '.flex { display: flex; }',
    'grid': '.grid { display: grid; }',
    'hidden': '.hidden { display: none; }',
    'block': '.block { display: block; }',
    'inline-flex': '.inline-flex { display: inline-flex; }',
    'flex-col': '.flex-col { flex-direction: column; }',
    'flex-row': '.flex-row { flex-direction: row; }',
    'flex-wrap': '.flex-wrap { flex-wrap: wrap; }',
    'flex-1': '.flex-1 { flex: 1 1 0%; }',
    'items-center': '.items-center { align-items: center; }',
    'items-start': '.items-start { align-items: flex-start; }',
    'items-end': '.items-end { align-items: flex-end; }',
    'justify-center': '.justify-center { justify-content: center; }',
    'justify-between': '.justify-between { justify-content: space-between; }',
    'justify-start': '.justify-start { justify-content: flex-start; }',
    'justify-end': '.justify-end { justify-content: flex-end; }',
    'relative': '.relative { position: relative; }',
    'absolute': '.absolute { position: absolute; }',
    'fixed': '.fixed { position: fixed; }',
    'sticky': '.sticky { position: sticky; }',
    'inset-0': '.inset-0 { inset: 0px; }',
    'top-0': '.top-0 { top: 0px; }',
    'right-0': '.right-0 { right: 0px; }',
    'bottom-0': '.bottom-0 { bottom: 0px; }',
    'left-0': '.left-0 { left: 0px; }',
    'overflow-hidden': '.overflow-hidden { overflow: hidden; }',
    'overflow-auto': '.overflow-auto { overflow: auto; }',
    'rounded': '.rounded { border-radius: 0.25rem; }',
    'rounded-lg': '.rounded-lg { border-radius: 0.5rem; }',
    'rounded-xl': '.rounded-xl { border-radius: 0.75rem; }',
    'rounded-2xl': '.rounded-2xl { border-radius: 1rem; }',
    'rounded-full': '.rounded-full { border-radius: 9999px; }',
    'border': '.border { border-width: 1px; }',
    'border-2': '.border-2 { border-width: 2px; }',
    'shadow': '.shadow { box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1); }',
    'shadow-lg': '.shadow-lg { box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1); }',
    'shadow-xl': '.shadow-xl { box-shadow: 0 20px 25px -5px rgb(0 0 0 / 0.1); }',
    'transition': '.transition { transition-property: all; transition-duration: 150ms; }',
    'transition-all': '.transition-all { transition-property: all; transition-duration: 150ms; }',
    'duration-200': '.duration-200 { transition-duration: 200ms; }',
    'duration-300': '.duration-300 { transition-duration: 300ms; }',
    'cursor-pointer': '.cursor-pointer { cursor: pointer; }',
    'pointer-events-none': '.pointer-events-none { pointer-events: none; }',
    'select-none': '.select-none { user-select: none; }',
    'opacity-0': '.opacity-0 { opacity: 0; }',
    'opacity-50': '.opacity-50 { opacity: 0.5; }',
    'opacity-100': '.opacity-100 { opacity: 1; }',
    'text-xs': '.text-xs { font-size: 0.75rem; line-height: 1rem; }',
    'text-sm': '.text-sm { font-size: 0.875rem; line-height: 1.25rem; }',
    'text-base': '.text-base { font-size: 1rem; line-height: 1.5rem; }',
    'text-lg': '.text-lg { font-size: 1.125rem; line-height: 1.75rem; }',
    'text-xl': '.text-xl { font-size: 1.25rem; line-height: 1.75rem; }',
    'text-2xl': '.text-2xl { font-size: 1.5rem; line-height: 2rem; }',
    'text-3xl': '.text-3xl { font-size: 1.875rem; line-height: 2.25rem; }',
    'text-4xl': '.text-4xl { font-size: 2.25rem; line-height: 2.5rem; }',
    'font-normal': '.font-normal { font-weight: 400; }',
    'font-medium': '.font-medium { font-weight: 500; }',
    'font-semibold': '.font-semibold { font-weight: 600; }',
    'font-bold': '.font-bold { font-weight: 700; }',
    'text-center': '.text-center { text-align: center; }',
    'text-left': '.text-left { text-align: left; }',
    'text-right': '.text-right { text-align: right; }',
    'uppercase': '.uppercase { text-transform: uppercase; }',
    'lowercase': '.lowercase { text-transform: lowercase; }',
    'capitalize': '.capitalize { text-transform: capitalize; }',
    'truncate': '.truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    'whitespace-nowrap': '.whitespace-nowrap { white-space: nowrap; }',
    'w-full': '.w-full { width: 100%; }',
    'w-auto': '.w-auto { width: auto; }',
    'h-full': '.h-full { height: 100%; }',
    'h-auto': '.h-auto { height: auto; }',
    'h-screen': '.h-screen { height: 100vh; }',
    'min-h-screen': '.min-h-screen { min-height: 100vh; }',
    'max-w-full': '.max-w-full { max-width: 100%; }',
    'max-w-screen-xl': '.max-w-screen-xl { max-width: 1280px; }',
    'mx-auto': '.mx-auto { margin-left: auto; margin-right: auto; }',
    'animate-spin': '.animate-spin { animation: spin 1s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }',
    'animate-pulse': '.animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; } @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }',
    'animate-bounce': '.animate-bounce { animation: bounce 1s infinite; } @keyframes bounce { 0%, 100% { transform: translateY(-25%); } 50% { transform: translateY(0); } }',
    'sr-only': '.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border-width: 0; }',
  };

  // Add spacing utilities
  const spacingScale: Record<string, string> = {
    '0': '0px', '1': '0.25rem', '2': '0.5rem', '3': '0.75rem', '4': '1rem',
    '5': '1.25rem', '6': '1.5rem', '8': '2rem', '10': '2.5rem', '12': '3rem',
    '16': '4rem', '20': '5rem', '24': '6rem', 'px': '1px'
  };

  for (const [key, value] of Object.entries(spacingScale)) {
    utilities[`m-${key}`] = `.m-${key} { margin: ${value}; }`;
    utilities[`mx-${key}`] = `.mx-${key} { margin-left: ${value}; margin-right: ${value}; }`;
    utilities[`my-${key}`] = `.my-${key} { margin-top: ${value}; margin-bottom: ${value}; }`;
    utilities[`mt-${key}`] = `.mt-${key} { margin-top: ${value}; }`;
    utilities[`mr-${key}`] = `.mr-${key} { margin-right: ${value}; }`;
    utilities[`mb-${key}`] = `.mb-${key} { margin-bottom: ${value}; }`;
    utilities[`ml-${key}`] = `.ml-${key} { margin-left: ${value}; }`;
    utilities[`p-${key}`] = `.p-${key} { padding: ${value}; }`;
    utilities[`px-${key}`] = `.px-${key} { padding-left: ${value}; padding-right: ${value}; }`;
    utilities[`py-${key}`] = `.py-${key} { padding-top: ${value}; padding-bottom: ${value}; }`;
    utilities[`pt-${key}`] = `.pt-${key} { padding-top: ${value}; }`;
    utilities[`pr-${key}`] = `.pr-${key} { padding-right: ${value}; }`;
    utilities[`pb-${key}`] = `.pb-${key} { padding-bottom: ${value}; }`;
    utilities[`pl-${key}`] = `.pl-${key} { padding-left: ${value}; }`;
    utilities[`gap-${key}`] = `.gap-${key} { gap: ${value}; }`;
    utilities[`w-${key}`] = `.w-${key} { width: ${value}; }`;
    utilities[`h-${key}`] = `.h-${key} { height: ${value}; }`;
    utilities[`space-x-${key}`] = `.space-x-${key} > :not([hidden]) ~ :not([hidden]) { margin-left: ${value}; }`;
    utilities[`space-y-${key}`] = `.space-y-${key} > :not([hidden]) ~ :not([hidden]) { margin-top: ${value}; }`;
  }

  // Add color utilities
  const colors: Record<string, string> = {
    'white': '#fff', 'black': '#000', 'transparent': 'transparent',
    'gray-100': '#f3f4f6', 'gray-200': '#e5e7eb', 'gray-300': '#d1d5db',
    'gray-400': '#9ca3af', 'gray-500': '#6b7280', 'gray-600': '#4b5563',
    'gray-700': '#374151', 'gray-800': '#1f2937', 'gray-900': '#111827',
    'red-500': '#ef4444', 'green-500': '#22c55e', 'blue-500': '#3b82f6',
    'primary': 'hsl(var(--primary))', 'secondary': 'hsl(var(--secondary))',
    'muted': 'hsl(var(--muted))', 'accent': 'hsl(var(--accent))',
    'destructive': 'hsl(var(--destructive))', 'background': 'hsl(var(--background))',
    'foreground': 'hsl(var(--foreground))', 'card': 'hsl(var(--card))',
    'border': 'hsl(var(--border))', 'input': 'hsl(var(--input))',
  };

  for (const [name, value] of Object.entries(colors)) {
    utilities[`bg-${name}`] = `.bg-${name} { background-color: ${value}; }`;
    utilities[`text-${name}`] = `.text-${name} { color: ${value}; }`;
    utilities[`border-${name}`] = `.border-${name} { border-color: ${value}; }`;
  }

  // Add z-index
  for (const z of [0, 10, 20, 30, 40, 50]) {
    utilities[`z-${z}`] = `.z-${z} { z-index: ${z}; }`;
  }

  let css = tailwindBase + '\n' + cssVars + '\n';
  
  for (const className of usedClasses) {
    const baseClass = className.replace(/^(hover|focus|active|disabled|dark|sm|md|lg|xl|2xl):/, '');
    if (utilities[baseClass]) {
      if (className.startsWith('hover:')) {
        const ruleBody = utilities[baseClass].match(/\{([^}]+)\}/)?.[1] || '';
        css += `.hover\\:${baseClass}:hover { ${ruleBody} }\n`;
      } else if (className.startsWith('focus:')) {
        const ruleBody = utilities[baseClass].match(/\{([^}]+)\}/)?.[1] || '';
        css += `.focus\\:${baseClass}:focus { ${ruleBody} }\n`;
      } else if (className.startsWith('sm:')) {
        const ruleBody = utilities[baseClass].match(/\{([^}]+)\}/)?.[1] || '';
        css += `@media (min-width: 640px) { .sm\\:${baseClass} { ${ruleBody} } }\n`;
      } else if (className.startsWith('md:')) {
        const ruleBody = utilities[baseClass].match(/\{([^}]+)\}/)?.[1] || '';
        css += `@media (min-width: 768px) { .md\\:${baseClass} { ${ruleBody} } }\n`;
      } else if (className.startsWith('lg:')) {
        const ruleBody = utilities[baseClass].match(/\{([^}]+)\}/)?.[1] || '';
        css += `@media (min-width: 1024px) { .lg\\:${baseClass} { ${ruleBody} } }\n`;
      } else {
        css += utilities[baseClass] + '\n';
      }
    } else if (utilities[className]) {
      css += utilities[className] + '\n';
    }
  }

  return css;
}

// Resolve import path
function resolveImport(
  importPath: string, 
  importer: string, 
  sourceFiles: Record<string, string>,
  monorepoInfo: MonorepoInfo,
  packageJson: PackageJson | null,
  allDeps: Record<string, string>
): { resolved: string; isExternal: boolean } {
  const extensions = [".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
  
  // Relative imports
  if (importPath.startsWith(".")) {
    const basedir = importer.replace(/\/[^/]+$/, "");
    let resolved = `${basedir}/${importPath}`.replace(/\/+/g, "/").replace(/^\//, "");
    
    for (const ext of extensions) {
      const candidate = resolved + ext;
      if (sourceFiles[candidate]) {
        return { resolved: candidate, isExternal: false };
      }
    }
    // Try without extension
    if (sourceFiles[resolved]) {
      return { resolved, isExternal: false };
    }
    return { resolved, isExternal: false };
  }
  
  // Path alias (@/ or src/)
  if (importPath.startsWith("@/") || importPath.startsWith("src/")) {
    const path = importPath.replace(/^@\//, "src/");
    for (const ext of extensions) {
      const candidate = path + ext;
      if (sourceFiles[candidate]) {
        return { resolved: candidate, isExternal: false };
      }
    }
  }
  
  // Workspace package
  if (importPath.startsWith("@")) {
    const workspacePkg = monorepoInfo.packages.find(p => p.name === importPath);
    if (workspacePkg) {
      const entryPaths = [
        `${workspacePkg.path}/src/index.tsx`,
        `${workspacePkg.path}/src/index.ts`,
        `${workspacePkg.path}/index.tsx`,
        `${workspacePkg.path}/index.ts`,
      ];
      for (const ep of entryPaths) {
        if (sourceFiles[ep]) {
          return { resolved: ep, isExternal: false };
        }
      }
    }
  }
  
  // External npm package - resolve to esm.sh
  const version = getDependencyVersion(importPath, packageJson, allDeps);
  return { resolved: `https://esm.sh/${importPath}@${version}`, isExternal: true };
}

// Bundle all source files into a single module
function bundleFiles(
  entryPoint: string,
  sourceFiles: Record<string, string>,
  monorepoInfo: MonorepoInfo,
  packageJson: PackageJson | null,
  allDeps: Record<string, string>
): string {
  const visited = new Set<string>();
  const bundled: string[] = [];
  const externals = new Set<string>();
  
  function processFile(filePath: string) {
    if (visited.has(filePath) || !sourceFiles[filePath]) return;
    visited.add(filePath);
    
    let code = sourceFiles[filePath];
    
    // Extract and process imports
    const importRegex = /import\s+(?:(\{[^}]+\})|(\*\s+as\s+\w+)|(\w+))?\s*,?\s*(?:(\{[^}]+\})|(\w+))?\s*from\s+['"]([^'"]+)['"]/g;
    const imports: string[] = [];
    
    code = code.replace(importRegex, (match, named1, star, defaultImport, named2, defaultImport2, importPath) => {
      const { resolved, isExternal } = resolveImport(importPath, filePath, sourceFiles, monorepoInfo, packageJson, allDeps);
      
      if (isExternal) {
        externals.add(resolved);
        // Keep external imports but update the path
        return match.replace(importPath, resolved);
      } else {
        // Process local file
        processFile(resolved);
        // Remove the import (will be available in bundled scope)
        return `// bundled: ${importPath}`;
      }
    });
    
    // Transform the code
    code = transformCode(code, filePath);
    
    bundled.push(`// === ${filePath} ===\n${code}`);
  }
  
  processFile(entryPoint);
  
  // Build external imports header
  const externalImports = Array.from(externals).map(url => {
    const pkgName = url.replace('https://esm.sh/', '').replace(/@[^/]+$/, '');
    return `import * as ${pkgName.replace(/[^a-zA-Z0-9]/g, '_')} from "${url}";`;
  }).join('\n');
  
  return externalImports + '\n\n' + bundled.join('\n\n');
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

function generateInlineHtml(bundledJs: string, bundledCss: string, reactVersion: string): string {
  // For inline HTML, we use esm.sh imports at runtime
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
import React from "https://esm.sh/react@${reactVersion}";
import ReactDOM from "https://esm.sh/react-dom@${reactVersion}/client";

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

    log("Analyzing project structure...");
    const monorepoInfo = detectMonorepo(files);
    const packageJson = monorepoInfo.rootPackageJson;
    const allDeps = monorepoInfo.allDependencies;
    
    if (monorepoInfo.isMonorepo) {
      log(`Monorepo detected with ${monorepoInfo.packages.length} packages`);
    }
    
    const depCount = Object.keys(allDeps).length;
    log(`Total dependencies: ${depCount}`);

    // Find entry point
    let entryPoint: string | null = null;
    let entryPackage: WorkspacePackage | null = null;
    
    if (monorepoInfo.isMonorepo && monorepoInfo.packages.length > 0) {
      for (const pkg of monorepoInfo.packages) {
        if (pkg.entryPoint) {
          entryPoint = pkg.entryPoint;
          entryPackage = pkg;
          log(`Using entry point from workspace package: ${pkg.name}`);
          break;
        }
      }
    }
    
    if (!entryPoint) {
      const standardEntryPoints = [
        "src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.jsx",
        "main.tsx", "main.jsx", "index.tsx", "index.jsx",
      ];
      
      for (const ep of standardEntryPoints) {
        if (files.has(ep)) {
          entryPoint = ep;
          break;
        }
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

    // Collect source files
    const sourceFiles: Record<string, string> = {};
    let sourceFileCount = 0;
    
    for (const [path, content] of files) {
      if (path.endsWith(".tsx") || path.endsWith(".ts") || path.endsWith(".jsx") || path.endsWith(".js")) {
        sourceFiles[path] = new TextDecoder().decode(content);
        sourceFileCount++;
      }
    }
    
    log(`Processing ${sourceFileCount} source files`);

    // Extract CSS variables
    let cssVars = "";
    const cssLocations = ["src/index.css", "index.css"];
    
    for (const cssPath of cssLocations) {
      const indexCss = files.get(cssPath);
      if (indexCss) {
        const cssContent = new TextDecoder().decode(indexCss);
        const rootMatch = cssContent.match(/:root\s*\{[^}]+\}/g);
        const darkMatch = cssContent.match(/\.dark\s*\{[^}]+\}/g);
        if (rootMatch) cssVars += rootMatch.join('\n') + '\n';
        if (darkMatch) cssVars += darkMatch.join('\n') + '\n';
        log(`Extracted CSS variables from ${cssPath}`);
        break;
      }
    }

    // Extract Tailwind classes and generate CSS
    log("Extracting Tailwind classes...");
    const usedClasses = extractTailwindClasses(sourceFiles);
    log(`Found ${usedClasses.size} unique Tailwind classes`);
    
    const tailwindCss = generateTailwindCSS(usedClasses, cssVars);
    log(`Generated ${(tailwindCss.length / 1024).toFixed(1)} KB of Tailwind CSS`);

    // Collect additional CSS
    let additionalCss = "";
    let cssFileCount = 0;
    for (const [path, content] of files) {
      if (path.endsWith(".css") && path !== "src/index.css" && path !== "index.css") {
        additionalCss += `/* ${path} */\n` + new TextDecoder().decode(content) + "\n\n";
        cssFileCount++;
      }
    }
    
    const combinedCss = tailwindCss + "\n" + additionalCss;
    log(`Total CSS: ${cssFileCount + 1} files processed`);

    // Bundle the JavaScript
    log("Bundling JavaScript...");
    let bundledJs = "";
    try {
      bundledJs = bundleFiles(entryPoint, sourceFiles, monorepoInfo, packageJson, allDeps);
      log(`Bundle complete: ${(bundledJs.length / 1024).toFixed(1)} KB`);
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
    log("Creating ZIP archive...");
    
    const zipFiles: Record<string, Uint8Array> = {
      "index.html": strToU8(generateHtml("bundle.js", "styles.css")),
      "bundle.js": strToU8(bundledJs),
      "styles.css": strToU8(combinedCss),
    };
    
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

    const reactVersion = getDependencyVersion("react", packageJson, allDeps);
    const inlineHtml = generateInlineHtml(bundledJs, combinedCss, reactVersion);
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
          dependencies: depCount,
          isMonorepo: monorepoInfo.isMonorepo,
          workspacePackages: monorepoInfo.packages.length,
          entryPackage: entryPackage?.name || null,
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
