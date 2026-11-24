ALTER TABLE "Resume"
  ADD COLUMN "materialRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Job"
  ADD COLUMN "finalResumeAssignmentRevision" INTEGER NOT NULL DEFAULT 0;

CREATE FUNCTION "applymate_resume_material_revision"() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."materialRevision" := 0;
    RETURN NEW;
  END IF;

  IF ROW(NEW."name", NEW."content", NEW."templateId", NEW."templateOptions", NEW."kind",
         NEW."targetJobId", NEW."parentResumeId", NEW."basicsDetached")
     IS DISTINCT FROM
     ROW(OLD."name", OLD."content", OLD."templateId", OLD."templateOptions", OLD."kind",
         OLD."targetJobId", OLD."parentResumeId", OLD."basicsDetached") THEN
    NEW."materialRevision" := OLD."materialRevision" + 1;
  ELSE
    NEW."materialRevision" := OLD."materialRevision";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Resume_material_revision"
  BEFORE INSERT OR UPDATE ON "Resume"
  FOR EACH ROW EXECUTE FUNCTION "applymate_resume_material_revision"();

CREATE FUNCTION "applymate_job_final_resume_assignment_revision"() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."finalResumeAssignmentRevision" := 0;
    RETURN NEW;
  END IF;

  IF NEW."finalResumeId" IS DISTINCT FROM OLD."finalResumeId" THEN
    NEW."finalResumeAssignmentRevision" := OLD."finalResumeAssignmentRevision" + 1;
  ELSE
    NEW."finalResumeAssignmentRevision" := OLD."finalResumeAssignmentRevision";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Job_final_resume_assignment_revision"
  BEFORE INSERT OR UPDATE ON "Job"
  FOR EACH ROW EXECUTE FUNCTION "applymate_job_final_resume_assignment_revision"();
