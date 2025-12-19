-- Create storage bucket for React project uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('react-projects', 'react-projects', false);

-- Create storage bucket for built static files
INSERT INTO storage.buckets (id, name, public)
VALUES ('static-builds', 'static-builds', true);

-- Allow public uploads to react-projects bucket (no auth required)
CREATE POLICY "Allow public uploads to react-projects"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'react-projects');

-- Allow public read from static-builds bucket
CREATE POLICY "Allow public read from static-builds"
ON storage.objects
FOR SELECT
USING (bucket_id = 'static-builds');

-- Allow public inserts to static-builds bucket
CREATE POLICY "Allow public inserts to static-builds"
ON storage.objects
FOR INSERT
WITH CHECK (bucket_id = 'static-builds');

-- Create table to track build jobs
CREATE TABLE public.build_jobs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  input_file_path TEXT NOT NULL,
  output_file_path TEXT,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  completed_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.build_jobs ENABLE ROW LEVEL SECURITY;

-- Allow anyone to create and read build jobs (no auth required)
CREATE POLICY "Allow public to create build jobs"
ON public.build_jobs
FOR INSERT
WITH CHECK (true);

CREATE POLICY "Allow public to read build jobs"
ON public.build_jobs
FOR SELECT
USING (true);

CREATE POLICY "Allow public to update build jobs"
ON public.build_jobs
FOR UPDATE
USING (true);