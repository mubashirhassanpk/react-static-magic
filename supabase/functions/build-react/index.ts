import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import * as esbuild from "https://deno.land/x/esbuild@v0.20.1/wasm.js";
import { decompressSync } from "https://esm.sh/fflate@0.8.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Initialize esbuild WASM
let esbuildInitialized = false;
async function initEsbuild() {
  if (!esbuildInitialized) {
    await esbuild.initialize({
      wasmURL: "https://deno.land/x/esbuild@v0.20.1/esbuild.wasm",
    });
    esbuildInitialized = true;
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
    const uncompressedSize = view.getUint32(offset + 22, true);
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
        console.log(`Unsupported compression method: ${compressionMethod} for ${fileName}`);
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

// Transform imports to use esm.sh CDN
function transformImports(code: string): string {
  // Transform React imports
  code = code.replace(
    /from\s+['"]react['"]/g,
    'from "https://esm.sh/react@18.2.0"'
  );
  code = code.replace(
    /from\s+['"]react-dom['"]/g,
    'from "https://esm.sh/react-dom@18.2.0"'
  );
  code = code.replace(
    /from\s+['"]react-dom\/client['"]/g,
    'from "https://esm.sh/react-dom@18.2.0/client"'
  );
  
  // Transform common libraries
  const cdnLibraries = [
    "react-router-dom",
    "@tanstack/react-query",
    "zustand",
    "axios",
    "framer-motion",
    "lucide-react",
    "clsx",
    "tailwind-merge",
  ];
  
  for (const lib of cdnLibraries) {
    const escapedLib = lib.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`from\\s+['"]${escapedLib}['"]`, "g");
    code = code.replace(regex, `from "https://esm.sh/${lib}"`);
  }
  
  return code;
}

// Generate index.html
function generateHtml(bundledJs: string, bundledCss: string): string {
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

  try {
    await initEsbuild();
    
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { jobId } = await req.json();

    if (!jobId) {
      return new Response(
        JSON.stringify({ success: false, error: "Job ID is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Processing build job: ${jobId}`);

    // Get the build job
    const { data: job, error: jobError } = await supabase
      .from("build_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();

    if (jobError || !job) {
      console.error("Job not found:", jobError);
      return new Response(
        JSON.stringify({ success: false, error: "Build job not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update status to processing
    await supabase
      .from("build_jobs")
      .update({ status: "processing" })
      .eq("id", jobId);

    console.log(`Downloading input file: ${job.input_file_path}`);

    // Download the uploaded ZIP file
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("react-projects")
      .download(job.input_file_path);

    if (downloadError || !fileData) {
      console.error("Failed to download file:", downloadError);
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "Failed to download uploaded file",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to download uploaded file" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`File downloaded, size: ${fileData.size} bytes`);

    // Parse ZIP file
    const zipData = new Uint8Array(await fileData.arrayBuffer());
    let files: Map<string, Uint8Array>;
    
    try {
      files = parseZip(zipData);
      console.log(`Extracted ${files.size} files from ZIP`);
    } catch (zipError) {
      console.error("Failed to parse ZIP:", zipError);
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "Failed to parse ZIP file. Ensure it's a valid ZIP archive.",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to parse ZIP file" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
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
      console.error("No entry point found");
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "No entry point found. Please ensure your project has src/main.tsx or similar entry file.",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "No entry point found" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Found entry point: ${entryPoint}`);

    // Collect all source files for bundling
    const sourceFiles: Record<string, string> = {};
    for (const [path, content] of files) {
      if (path.endsWith(".tsx") || path.endsWith(".ts") || path.endsWith(".jsx") || path.endsWith(".js")) {
        let code = new TextDecoder().decode(content);
        code = transformImports(code);
        sourceFiles[path] = code;
      }
    }

    // Collect CSS files
    let combinedCss = "";
    for (const [path, content] of files) {
      if (path.endsWith(".css")) {
        combinedCss += new TextDecoder().decode(content) + "\n";
      }
    }

    console.log(`Processing ${Object.keys(sourceFiles).length} source files and CSS`);

    // Bundle with esbuild
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
            return { path: `https://esm.sh/${args.path}`, external: true };
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
        jsxImportSource: "https://esm.sh/react@18.2.0",
      });
      
      bundledJs = new TextDecoder().decode(result.outputFiles[0].contents);
      console.log(`Bundled JS size: ${bundledJs.length} characters`);
    } catch (bundleError) {
      console.error("Bundle error:", bundleError);
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
        JSON.stringify({ success: false, error: `Build failed: ${errorMessage}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Generate final HTML
    const finalHtml = generateHtml(bundledJs, combinedCss);
    
    const outputPath = `${jobId}/index.html`;
    console.log(`Uploading build output to: ${outputPath}`);

    // Upload the built output
    const { error: uploadError } = await supabase.storage
      .from("static-builds")
      .upload(outputPath, new TextEncoder().encode(finalHtml), {
        contentType: "text/html",
        upsert: true
      });

    if (uploadError) {
      console.error("Failed to upload build output:", uploadError);
      await supabase
        .from("build_jobs")
        .update({ 
          status: "failed", 
          error_message: "Failed to save build output",
          completed_at: new Date().toISOString()
        })
        .eq("id", jobId);
      return new Response(
        JSON.stringify({ success: false, error: "Failed to save build output" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Update job as completed
    await supabase
      .from("build_jobs")
      .update({ 
        status: "completed", 
        output_file_path: outputPath,
        completed_at: new Date().toISOString()
      })
      .eq("id", jobId);

    // Get public URL for the output
    const { data: publicUrlData } = supabase.storage
      .from("static-builds")
      .getPublicUrl(outputPath);

    console.log(`Build completed successfully for job: ${jobId}`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        downloadUrl: publicUrlData.publicUrl,
        message: "Build completed successfully",
        stats: {
          filesProcessed: files.size,
          sourceFiles: Object.keys(sourceFiles).length,
          bundleSize: bundledJs.length,
          cssSize: combinedCss.length
        }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Build error:", error);
    const errorMessage = error instanceof Error ? error.message : "Build failed";
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
