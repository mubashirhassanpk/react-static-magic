import { Zap, Lock, Download, Eye, Clock, Boxes } from "lucide-react";

const Features = () => {
  const features = [
    {
      icon: Zap,
      title: "Lightning Fast",
      description: "Automated builds complete in under 30 seconds",
    },
    {
      icon: Lock,
      title: "No Login Required",
      description: "Start building immediately without creating an account",
    },
    {
      icon: Download,
      title: "Download as ZIP",
      description: "Get your static site packaged and ready to deploy",
    },
    {
      icon: Eye,
      title: "Live Preview",
      description: "See your built site instantly with a preview link",
    },
    {
      icon: Clock,
      title: "Real-time Progress",
      description: "Watch the build process with live status updates",
    },
    {
      icon: Boxes,
      title: "Multiple Sources",
      description: "Support for ZIP uploads, code paste, and GitHub",
    },
  ];

  return (
    <section className="py-24 px-6">
      <div className="container mx-auto max-w-6xl">
        <div className="text-center mb-16 space-y-4">
          <h2 className="text-4xl md:text-5xl font-bold">
            Powerful <span className="bg-gradient-accent bg-clip-text text-transparent">Features</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Everything you need to convert React to static sites
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <div
              key={index}
              className="group p-6 rounded-xl bg-card border border-border hover:border-primary transition-all duration-300 hover:shadow-glow-primary"
            >
              <div className="w-12 h-12 rounded-lg bg-gradient-primary flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300">
                <feature.icon className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold mb-2">{feature.title}</h3>
              <p className="text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default Features;
