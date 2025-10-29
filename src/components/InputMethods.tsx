import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, Code2, Github } from "lucide-react";

const InputMethods = () => {
  const methods = [
    {
      icon: Upload,
      title: "Upload ZIP",
      description: "Drag and drop your React project as a ZIP file",
      action: "Upload Project",
      gradient: "from-primary/20 to-primary/5",
    },
    {
      icon: Code2,
      title: "Paste Code",
      description: "Paste your React code directly into our editor",
      action: "Open Editor",
      gradient: "from-accent/20 to-accent/5",
    },
    {
      icon: Github,
      title: "Connect GitHub",
      description: "Link your GitHub repository for instant builds",
      action: "Connect Repo",
      gradient: "from-primary/20 to-accent/5",
    },
  ];

  return (
    <section className="py-24 px-6">
      <div className="container mx-auto max-w-6xl">
        <div className="text-center mb-16 space-y-4">
          <h2 className="text-4xl md:text-5xl font-bold">
            Three Ways to <span className="text-primary">Build</span>
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Choose the method that works best for your workflow
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {methods.map((method, index) => (
            <Card
              key={index}
              className="group hover:border-primary transition-all duration-300 hover:shadow-glow-primary bg-card/50 backdrop-blur-sm"
            >
              <CardHeader>
                <div className={`w-14 h-14 rounded-xl bg-gradient-to-br ${method.gradient} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300`}>
                  <method.icon className="w-7 h-7 text-foreground" />
                </div>
                <CardTitle className="text-2xl">{method.title}</CardTitle>
                <CardDescription className="text-base">
                  {method.description}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" className="w-full group-hover:border-primary">
                  {method.action}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
};

export default InputMethods;
