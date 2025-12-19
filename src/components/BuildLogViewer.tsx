import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";

interface BuildLogViewerProps {
  logs: string[];
  isBuilding: boolean;
}

const BuildLogViewer = ({ logs, isBuilding }: BuildLogViewerProps) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(true);

  useEffect(() => {
    if (scrollRef.current && isBuilding) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, isBuilding]);

  const getLogColor = (log: string) => {
    if (log.includes("❌") || log.includes("error")) {
      return "text-red-400";
    }
    if (log.includes("⚠️") || log.includes("warn")) {
      return "text-yellow-400";
    }
    if (log.includes("✅")) {
      return "text-green-400";
    }
    return "text-muted-foreground";
  };

  if (logs.length === 0) return null;

  return (
    <div className="mt-4 rounded-lg border border-border bg-background/95 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-2 bg-muted/50 hover:bg-muted/70 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">Build Log</span>
          <span className="text-xs text-muted-foreground">
            ({logs.length} entries)
          </span>
        </div>
        {isExpanded ? (
          <ChevronUp className="w-4 h-4" />
        ) : (
          <ChevronDown className="w-4 h-4" />
        )}
      </button>
      
      {isExpanded && (
        <ScrollArea className="h-48" ref={scrollRef}>
          <div className="p-3 font-mono text-xs space-y-1">
            {logs.map((log, index) => (
              <div
                key={index}
                className={`${getLogColor(log)} leading-relaxed`}
              >
                {log}
              </div>
            ))}
            {isBuilding && (
              <div className="flex items-center gap-2 text-primary animate-pulse">
                <span className="inline-block w-2 h-2 bg-primary rounded-full animate-bounce" />
                <span>Building...</span>
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
};

export default BuildLogViewer;
