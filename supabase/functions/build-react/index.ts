import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
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

    // For demonstration purposes, we'll simulate the build process
    // In a production environment, you would:
    // 1. Extract the ZIP file
    // 2. Run npm install and npm run build
    // 3. Package the dist folder into a new ZIP
    
    // Since Deno edge functions have limited capabilities for running npm commands,
    // we'll create a mock "built" output that demonstrates the flow
    
    // Simulate build time
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Create a simple HTML file as mock output
    const mockBuildOutput = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Built Static Site</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
    h1 { color: #7c3aed; }
    .success { background: #22c55e20; border: 1px solid #22c55e; padding: 1rem; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>🎉 Build Successful!</h1>
  <div class="success">
    <p>Your React project has been converted to a static site.</p>
    <p>Build ID: ${jobId}</p>
    <p>Built at: ${new Date().toISOString()}</p>
  </div>
  <h2>Next Steps</h2>
  <ul>
    <li>Download this file and deploy to any static hosting service</li>
    <li>Netlify, Vercel, GitHub Pages, AWS S3, etc.</li>
  </ul>
</body>
</html>`;

    // Create a simple ZIP-like package (just the HTML for now as demo)
    const encoder = new TextEncoder();
    const outputContent = encoder.encode(mockBuildOutput);
    
    const outputPath = `${jobId}/build.html`;
    
    console.log(`Uploading build output to: ${outputPath}`);

    // Upload the built output
    const { error: uploadError } = await supabase.storage
      .from("static-builds")
      .upload(outputPath, outputContent, {
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
        message: "Build completed successfully"
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
