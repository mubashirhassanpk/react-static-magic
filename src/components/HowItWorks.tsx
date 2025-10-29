import { CheckCircle2 } from "lucide-react";

const HowItWorks = () => {
  const steps = [
    {
      number: "01",
      title: "Provide Your Code",
      description: "Upload a ZIP, paste code, or connect your GitHub repository",
    },
    {
      number: "02",
      title: "Automatic Build",
      description: "We run npm install and npm run build in the background",
    },
    {
      number: "03",
      title: "Get Your Site",
      description: "Download as ZIP or get a live preview link instantly",
    },
  ];

  return (
    <section className="py-24 px-6 bg-card/30">
      <div className="container mx-auto max-w-6xl">
        <div className="text-center mb-16 space-y-4">
          <h2 className="text-4xl md:text-5xl font-bold">
            How It <span className="text-accent">Works</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            From code to production in three simple steps
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8 relative">
          {/* Connection line */}
          <div className="hidden md:block absolute top-20 left-0 right-0 h-0.5 bg-gradient-to-r from-primary via-accent to-primary opacity-30" />
          
          {steps.map((step, index) => (
            <div key={index} className="relative">
              <div className="flex flex-col items-center text-center space-y-4">
                {/* Step number */}
                <div className="relative z-10 w-16 h-16 rounded-full bg-gradient-primary flex items-center justify-center shadow-glow-primary">
                  <span className="text-2xl font-bold">{step.number}</span>
                </div>
                
                {/* Content */}
                <div className="space-y-2">
                  <h3 className="text-2xl font-bold">{step.title}</h3>
                  <p className="text-muted-foreground">{step.description}</p>
                </div>

                {/* Check icon */}
                <CheckCircle2 className="w-8 h-8 text-accent opacity-50" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default HowItWorks;
