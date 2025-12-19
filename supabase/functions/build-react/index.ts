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
    
    // Local file header signature
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
        // Deflate
        fileData = decompressSync(compressedData);
      } else if (compressionMethod === 0) {
        // Stored (no compression)
        fileData = compressedData;
      } else {
        log(`Unsupported compression method: ${compressionMethod} for ${fileName}`, "warn");
        fileData = new Uint8Array(0);
      }
      
      // Remove top-level directory prefix if present
      const normalizedName = fileName.replace(/^[^/]+\//, "");
      if (normalizedName) {
        files.set(normalizedName, fileData);
      }
    }
    
    offset = dataStart + compressedSize;
  }
  
  return files;
}

// Parse package.json and extract dependencies
interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function parsePackageJson(files: Map<string, Uint8Array>): PackageJson | null {
  const packageJsonContent = files.get("package.json");
  if (!packageJsonContent) {
    log("No package.json found", "warn");
    return null;
  }
  
  try {
    const content = new TextDecoder().decode(packageJsonContent);
    const parsed = JSON.parse(content) as PackageJson;
    log(`Parsed package.json: ${parsed.name || "unnamed project"}`);
    return parsed;
  } catch (e) {
    log(`Failed to parse package.json: ${e}`, "error");
    return null;
  }
}

// Get version from package.json or use latest
function getDependencyVersion(
  dep: string,
  packageJson: PackageJson | null
): string {
  const version = packageJson?.dependencies?.[dep] || packageJson?.devDependencies?.[dep];
  if (version) {
    // Clean version string (remove ^, ~, etc.)
    return version.replace(/^[\^~><=]+/, "");
  }
  return "latest";
}

// Transform imports to use esm.sh CDN with package.json versions
function transformImports(code: string, packageJson: PackageJson | null): { code: string; warnings: string[] } {
  const warnings: string[] = [];
  
  // Common React ecosystem packages
  const knownPackages = [
    "react",
    "react-dom",
    "react-dom/client",
    "react-router-dom",
    "@tanstack/react-query",
    "zustand",
    "axios",
    "framer-motion",
    "lucide-react",
    "clsx",
    "tailwind-merge",
    "date-fns",
    "lodash",
    "uuid",
    "@radix-ui/react-accordion",
    "@radix-ui/react-alert-dialog",
    "@radix-ui/react-avatar",
    "@radix-ui/react-checkbox",
    "@radix-ui/react-dialog",
    "@radix-ui/react-dropdown-menu",
    "@radix-ui/react-label",
    "@radix-ui/react-popover",
    "@radix-ui/react-select",
    "@radix-ui/react-slot",
    "@radix-ui/react-switch",
    "@radix-ui/react-tabs",
    "@radix-ui/react-toast",
    "@radix-ui/react-tooltip",
  ];

  // Build dependency map from package.json
  const allDeps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };

  // Transform known packages with versions from package.json
  for (const pkg of knownPackages) {
    const escapedPkg = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`from\\s+['"]${escapedPkg}['"]`, "g");
    if (code.match(regex)) {
      const version = getDependencyVersion(pkg, packageJson);
      const cdnUrl = `https://esm.sh/${pkg}@${version}`;
      code = code.replace(regex, `from "${cdnUrl}"`);
      log(`Mapped ${pkg}@${version} to esm.sh`);
    }
  }

  // Transform any remaining bare imports from package.json dependencies
  if (allDeps) {
    for (const [dep, version] of Object.entries(allDeps)) {
      if (!knownPackages.includes(dep)) {
        const escapedDep = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`from\\s+['"]${escapedDep}['"]`, "g");
        if (code.match(regex)) {
          const cleanVersion = (version as string).replace(/^[\^~><=]+/, "");
          code = code.replace(regex, `from "https://esm.sh/${dep}@${cleanVersion}"`);
          log(`Mapped ${dep}@${cleanVersion} to esm.sh`);
        }
      }
    }
  }

  return { code, warnings };
}

// Generate index.html
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

// Generate inline HTML for preview
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

  // Clear logs for new build
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

    // Get the build job
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

    // Update status to processing
    await supabase
      .from("build_jobs")
      .update({ status: "processing" })
      .eq("id", jobId);

    log(`Downloading input file: ${job.input_file_path}`);

    // Download the uploaded ZIP file
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("react-projects")
      .download(job.input_file_path);

    if (downloadError || !fileData) {
      log(`Failed to download file: ${downloadError?.message}`, "error");
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "Failed to download uploaded file",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to download uploaded file", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`File downloaded, size: ${(fileData.size / 1024).toFixed(1)} KB`);

    // Parse ZIP file
    const zipData = new Uint8Array(await fileData.arrayBuffer());
    let files: Map<string, Uint8Array>;
    
    try {
      files = parseZip(zipData);
      log(`Extracted ${files.size} files from ZIP`);
      
      // Log file structure
      const dirs = new Set<string>();
      for (const path of files.keys()) {
        const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
        dirs.add(dir);
      }
      log(`Project directories: ${Array.from(dirs).slice(0, 5).join(", ")}${dirs.size > 5 ? "..." : ""}`);
    } catch (zipError) {
      log(`Failed to parse ZIP: ${zipError}`, "error");
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "Failed to parse ZIP file. Ensure it's a valid ZIP archive.",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to parse ZIP file", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse package.json for dependencies
    log("Parsing package.json for dependencies...");
    const packageJson = parsePackageJson(files);
    
    if (packageJson) {
      const depCount = Object.keys(packageJson.dependencies || {}).length;
      const devDepCount = Object.keys(packageJson.devDependencies || {}).length;
      log(`Found ${depCount} dependencies and ${devDepCount} dev dependencies`);
      
      // Log key dependencies
      const deps = Object.keys(packageJson.dependencies || {});
      if (deps.length > 0) {
        log(`Key deps: ${deps.slice(0, 5).join(", ")}${deps.length > 5 ? "..." : ""}`);
      }
    }

    // Find entry point (main.tsx, main.jsx, index.tsx, index.jsx, App.tsx, App.jsx)
    const entryPoints = ["src/main.tsx", "src/main.jsx", "src/index.tsx", "src/index.jsx", "main.tsx", "main.jsx", "index.tsx", "index.jsx"];
    let entryPoint: string | null = null;
    let entryContent: string | null = null;
    
    for (const ep of entryPoints) {
      if (files.has(ep)) {
        entryPoint = ep;
        entryContent = new TextDecoder().decode(files.get(ep)!);
        break;
      }
    }

    if (!entryPoint || !entryContent) {
      log("No entry point found (src/main.tsx, etc.)", "error");
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "No entry point found. Please ensure your project has src/main.tsx or similar entry file.",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "No entry point found", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    log(`Found entry point: ${entryPoint}`);

    // Collect all source files for bundling
    const sourceFiles: Record<string, string> = {};
    const allWarnings: string[] = [];
    let sourceFileCount = 0;
    
    for (const [path, content] of files) {
      if (path.endsWith(".tsx") || path.endsWith(".ts") || path.endsWith(".jsx") || path.endsWith(".js")) {
        let code = new TextDecoder().decode(content);
        const { code: transformedCode, warnings } = transformImports(code, packageJson);
        sourceFiles[path] = transformedCode;
        allWarnings.push(...warnings);
        sourceFileCount++;
      }
    }
    
    log(`Processing ${sourceFileCount} source files`);

    // Collect CSS files
    let combinedCss = "";
    let cssFileCount = 0;
    for (const [path, content] of files) {
      if (path.endsWith(".css")) {
        combinedCss += `/* ${path} */\n` + new TextDecoder().decode(content) + "\n\n";
        cssFileCount++;
      }
    }
    
    log(`Found ${cssFileCount} CSS files`);

    // Log warnings
    for (const warning of allWarnings) {
      log(warning, "warn");
    }

    // Bundle with esbuild
    log("Starting esbuild bundling...");
    let bundledJs = "";
    try {
      // Create a virtual file system plugin
      const virtualFs: esbuild.Plugin = {
        name: "virtual-fs",
        setup(build) {
          // Resolve relative imports
          build.onResolve({ filter: /^\./ }, (args) => {
            const basedir = args.importer ? args.importer.replace(/\/[^/]+$/, "") : "";
            let resolved = `${basedir}/${args.path}`.replace(/\/+/g, "/").replace(/^\//, "");
            
            // Try different extensions
            const extensions = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.jsx", "/index.js"];
            for (const ext of extensions) {
              const candidate = resolved + ext;
              if (sourceFiles[candidate]) {
                return { path: candidate, namespace: "virtual" };
              }
            }
            
            return { path: resolved, namespace: "virtual" };
          });
          
          // Resolve bare imports to esm.sh
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.path.startsWith("https://")) {
              return { path: args.path, external: true };
            }
            // Use version from package.json if available
            const version = getDependencyVersion(args.path, packageJson);
            return { path: `https://esm.sh/${args.path}@${version}`, external: true };
          });
          
          // Load virtual files
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
          contents: sourceFiles[entryPoint] || entryContent,
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
      
      // Log any esbuild warnings
      for (const warning of result.warnings) {
        log(`esbuild: ${warning.text}`, "warn");
      }
    } catch (bundleError) {
      log(`Bundle error: ${bundleError}`, "error");
      const errorMessage = bundleError instanceof Error ? bundleError.message : "Unknown build error";
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: `Build failed: ${errorMessage}`,
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: `Build failed: ${errorMessage}`, logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create ZIP file with all assets
    log("Creating ZIP archive with all assets...");
    
    const zipFiles: Record<string, Uint8Array> = {
      "index.html": strToU8(generateHtml("bundle.js", "styles.css")),
      "bundle.js": strToU8(bundledJs),
      "styles.css": strToU8(combinedCss),
    };
    
    // Include any static assets from public folder
    let assetCount = 0;
    for (const [path, content] of files) {
      if (path.startsWith("public/") && !path.endsWith("/")) {
        const assetPath = path.replace("public/", "");
        zipFiles[assetPath] = content;
        assetCount++;
      }
    }
    
    if (assetCount > 0) {
      log(`Included ${assetCount} static assets from public folder`);
    }

    const outputZip = zipSync(zipFiles, { level: 9 });
    log(`ZIP created: ${(outputZip.length / 1024).toFixed(1)} KB`);

    // Upload ZIP file
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

    // Also upload inline HTML for preview
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
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "Failed to save build output",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to save build output", logs: buildLogs }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update job as completed
    await supabase
      .from("build_jobs")
      .update({ 
        status: "completed", 
        output_file_path: zipOutputPath,
        completed_at: new Date().toISOString()
      })
      .eq("id", jobId);

    // Get public URLs
    const { data: zipUrlData } = supabase.storage
      .from("static-builds")
      .getPublicUrl(zipOutputPath);

    const { data: previewUrlData } = supabase.storage
      .from("static-builds")
      .getPublicUrl(htmlOutputPath);

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
          cssFiles: cssFileCount,
          bundleSize: bundledJs.length,
          cssSize: combinedCss.length,
          zipSize: outputZip.length,
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
