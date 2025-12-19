import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Upload, Loader2, Download, CheckCircle2, XCircle, FileArchive, ExternalLink, FileCode, Package, Layers } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import BuildLogViewer from "./BuildLogViewer";

type BuildStatus = "idle" | "uploading" | "building" | "completed" | "failed";

interface BuildStats {
  filesProcessed: number;
  sourceFiles: number;
  cssFiles: number;
  bundleSize: number;
  cssSize: number;
  zipSize: number;
  tailwindClasses: number;
  dependencies: number;
  devDependencies: number;
}

const UploadBuilder = () => {
  const [status, setStatus] = useState<BuildStatus>("idle");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [buildStats, setBuildStats] = useState<BuildStats | null>(null);
  const [buildLogs, setBuildLogs] = useState<string[]>([]);
  const { toast } = useToast();

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const processFile = async (file: File) => {
    if (!file.name.endsWith(".zip")) {
      toast({
        title: "Invalid file type",
        description: "Please upload a ZIP file containing your React project",
        variant: "destructive",
      });
      return;
    }

    setFileName(file.name);
    setStatus("uploading");
    setErrorMessage(null);
    setDownloadUrl(null);
    setPreviewUrl(null);
    setBuildLogs([]);
    setBuildStats(null);

    try {
      // Generate unique file path
      const timestamp = Date.now();
      const filePath = `${timestamp}/${file.name}`;

      setBuildLogs(prev => [...prev, `[${new Date().toISOString().substring(11, 19)}] → Uploading ${file.name}...`]);

      // Upload to storage
      const { error: uploadError } = await supabase.storage
        .from("react-projects")
        .upload(filePath, file);

      if (uploadError) {
        throw new Error(`Upload failed: ${uploadError.message}`);
      }

      setBuildLogs(prev => [...prev, `[${new Date().toISOString().substring(11, 19)}] → Upload complete, creating build job...`]);

      // Create build job
      const { data: job, error: jobError } = await supabase
        .from("build_jobs")
        .insert({
          input_file_path: filePath,
          status: "pending",
        })
        .select()
        .single();

      if (jobError || !job) {
        throw new Error(`Failed to create build job: ${jobError?.message}`);
      }

      setBuildLogs(prev => [...prev, `[${new Date().toISOString().substring(11, 19)}] → Build job created: ${job.id.substring(0, 8)}...`]);
      setStatus("building");

      // Trigger the build function
      const { data: buildResult, error: buildError } = await supabase.functions
        .invoke("build-react", {
          body: { jobId: job.id },
        });

      if (buildError) {
        throw new Error(`Build failed: ${buildError.message}`);
      }

      // Update logs from build result
      if (buildResult.logs && Array.isArray(buildResult.logs)) {
        setBuildLogs(buildResult.logs);
      }

      if (!buildResult.success) {
        throw new Error(buildResult.error || "Build failed");
      }

      setDownloadUrl(buildResult.downloadUrl);
      setPreviewUrl(buildResult.previewUrl);
      setBuildStats(buildResult.stats || null);
      setStatus("completed");
      
      toast({
        title: "Build completed!",
        description: `Processed ${buildResult.stats?.filesProcessed || 0} files`,
      });

    } catch (error) {
      console.error("Error:", error);
      setErrorMessage(error instanceof Error ? error.message : "An error occurred");
      setStatus("failed");
      
      toast({
        title: "Build failed",
        description: error instanceof Error ? error.message : "An error occurred",
        variant: "destructive",
      });
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      processFile(e.dataTransfer.files[0]);
    }
  }, []);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      processFile(e.target.files[0]);
    }
  };

  const resetState = () => {
    setStatus("idle");
    setDownloadUrl(null);
    setPreviewUrl(null);
    setErrorMessage(null);
    setFileName(null);
    setBuildStats(null);
    setBuildLogs([]);
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const getStatusContent = () => {
    switch (status) {
      case "uploading":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <Loader2 className="w-12 h-12 text-primary animate-spin" />
            <div className="text-center">
              <p className="text-lg font-medium">Uploading project...</p>
              <p className="text-sm text-muted-foreground">{fileName}</p>
            </div>
            <BuildLogViewer logs={buildLogs} isBuilding={true} />
          </div>
        );

      case "building":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="relative">
              <Loader2 className="w-12 h-12 text-primary animate-spin" />
              <div className="absolute inset-0 animate-ping opacity-20">
                <Loader2 className="w-12 h-12 text-primary" />
              </div>
            </div>
            <div className="text-center">
              <p className="text-lg font-medium">Building static site...</p>
              <p className="text-sm text-muted-foreground">Bundling with esbuild &amp; resolving dependencies</p>
            </div>
            <BuildLogViewer logs={buildLogs} isBuilding={true} />
          </div>
        );

      case "completed":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <CheckCircle2 className="w-12 h-12 text-green-500" />
            <div className="text-center">
              <p className="text-lg font-medium text-green-500">Build successful!</p>
              <p className="text-sm text-muted-foreground">Your static site is ready to download</p>
            </div>
            
            {buildStats && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-2xl py-4">
                <div className="text-center p-3 rounded-lg bg-muted/50">
                  <Package className="w-5 h-5 mx-auto mb-1 text-primary" />
                  <div className="text-lg font-semibold">{buildStats.filesProcessed}</div>
                  <div className="text-xs text-muted-foreground">Total Files</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-muted/50">
                  <FileCode className="w-5 h-5 mx-auto mb-1 text-accent" />
                  <div className="text-lg font-semibold">{buildStats.sourceFiles}</div>
                  <div className="text-xs text-muted-foreground">Source Files</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-muted/50">
                  <Layers className="w-5 h-5 mx-auto mb-1 text-primary" />
                  <div className="text-lg font-semibold">{buildStats.dependencies}</div>
                  <div className="text-xs text-muted-foreground">Dependencies</div>
                </div>
                <div className="text-center p-3 rounded-lg bg-muted/50">
                  <FileArchive className="w-5 h-5 mx-auto mb-1 text-green-500" />
                  <div className="text-lg font-semibold">{formatBytes(buildStats.zipSize)}</div>
                  <div className="text-xs text-muted-foreground">ZIP Size</div>
                </div>
              </div>
            )}
            
            <div className="flex flex-wrap gap-3 justify-center">
              {downloadUrl && (
                <Button asChild variant="default">
                  <a href={downloadUrl} download target="_blank" rel="noopener noreferrer">
                    <Download className="w-4 h-4 mr-2" />
                    Download ZIP
                  </a>
                </Button>
              )}
              {previewUrl && (
                <Button asChild variant="outline">
                  <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Preview
                  </a>
                </Button>
              )}
              <Button variant="ghost" onClick={resetState}>
                Build Another
              </Button>
            </div>
            
            <BuildLogViewer logs={buildLogs} isBuilding={false} />
          </div>
        );

      case "failed":
        return (
          <div className="flex flex-col items-center gap-4 py-8">
            <XCircle className="w-12 h-12 text-destructive" />
            <div className="text-center">
              <p className="text-lg font-medium text-destructive">Build failed</p>
              <p className="text-sm text-muted-foreground max-w-md">{errorMessage}</p>
            </div>
            <Button variant="outline" onClick={resetState}>
              Try Again
            </Button>
            <BuildLogViewer logs={buildLogs} isBuilding={false} />
          </div>
        );

      default:
        return (
          <div
            className={`border-2 border-dashed rounded-xl p-8 transition-all duration-300 cursor-pointer ${
              dragActive
                ? "border-primary bg-primary/10"
                : "border-border hover:border-primary/50"
            }`}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => document.getElementById("file-input")?.click()}
          >
            <input
              id="file-input"
              type="file"
              accept=".zip"
              onChange={handleFileInput}
              className="hidden"
            />
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center">
                <FileArchive className="w-8 h-8 text-primary" />
              </div>
              <div className="text-center">
                <p className="text-lg font-medium">
                  Drop your React project ZIP here
                </p>
                <p className="text-sm text-muted-foreground mt-1">
                  or click to browse
                </p>
              </div>
              <Button variant="outline" className="mt-2">
                <Upload className="w-4 h-4 mr-2" />
                Select ZIP File
              </Button>
            </div>
          </div>
        );
    }
  };

  return (
    <section id="builder" className="py-24 px-6 bg-muted/30">
      <div className="container mx-auto max-w-3xl">
        <Card className="border-primary/20 bg-card/80 backdrop-blur-sm">
          <CardHeader className="text-center">
            <CardTitle className="text-3xl">Build Your Static Site</CardTitle>
            <CardDescription className="text-base">
              Upload your React project and we'll convert it to a production-ready static site
            </CardDescription>
          </CardHeader>
          <CardContent>
            {getStatusContent()}
          </CardContent>
        </Card>
      </div>
    </section>
  );
};

export default UploadBuilder;
