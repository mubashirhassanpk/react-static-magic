import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

const CTA = () => {
  return (
    <section className="py-24 px-6 relative overflow-hidden">
      {/* Background effect */}
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-accent/10" />
      
      <div className="container mx-auto max-w-4xl relative z-10">
        <div className="text-center space-y-8 p-12 rounded-2xl bg-card/50 backdrop-blur-sm border border-border shadow-glow-primary">
          <h2 className="text-4xl md:text-5xl font-bold">
            Ready to Build Your{" "}
            <span className="bg-gradient-accent bg-clip-text text-transparent">
              Static Site?
            </span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            No sign-up required. No credit card needed. Just upload your code and get started.
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center pt-4">
            <Button variant="hero" size="lg" className="group">
              Start Building Now
              <ArrowRight className="ml-2 group-hover:translate-x-1 transition-transform" />
            </Button>
            <Button variant="outline" size="lg">
              View Documentation
            </Button>
          </div>

          <div className="pt-8 text-sm text-muted-foreground">
            Free forever • No hidden costs • Open source friendly
          </div>
        </div>
      </div>
    </section>
  );
};

export default CTA;
