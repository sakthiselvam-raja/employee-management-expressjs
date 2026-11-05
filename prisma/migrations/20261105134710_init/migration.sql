-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED');

-- CreateTable
CREATE TABLE "User" (
    "id" SERIAL NOT NULL,
    "employeeId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "middleName" TEXT,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZipUpload" (
    "id" SERIAL NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "zipPath" TEXT NOT NULL,
    "extractPath" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "totalFiles" INTEGER NOT NULL,
    "uploadedById" INTEGER NOT NULL,
    "uploadedByRole" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZipUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExcelFile" (
    "id" SERIAL NOT NULL,
    "zipUploadId" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sheetNames" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExcelFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageFolder" (
    "id" SERIAL NOT NULL,
    "zipUploadId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "imageCount" INTEGER NOT NULL,

    CONSTRAINT "ImageFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageFile" (
    "id" SERIAL NOT NULL,
    "folderId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "relativePath" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,

    CONSTRAINT "ImageFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "zipUploadId" INTEGER NOT NULL,
    "workDate" DATE NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "adminNotes" TEXT,
    "assignedById" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentExcel" (
    "id" SERIAL NOT NULL,
    "assignmentId" INTEGER NOT NULL,
    "excelFileId" INTEGER NOT NULL,

    CONSTRAINT "AssignmentExcel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentImageRange" (
    "id" SERIAL NOT NULL,
    "assignmentId" INTEGER NOT NULL,
    "imageFolderId" INTEGER NOT NULL,
    "startPosition" INTEGER NOT NULL,
    "endPosition" INTEGER NOT NULL,

    CONSTRAINT "AssignmentImageRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" SERIAL NOT NULL,
    "assignmentId" INTEGER NOT NULL,
    "uploadedById" INTEGER NOT NULL,
    "uploadedByRole" "Role" NOT NULL,
    "originalName" TEXT,
    "storedName" TEXT,
    "storagePath" TEXT,
    "sizeBytes" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER,
    "actorId" INTEGER,
    "actorRole" "Role",
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "ZipUpload_createdAt_idx" ON "ZipUpload"("createdAt");

-- CreateIndex
CREATE INDEX "ExcelFile_zipUploadId_idx" ON "ExcelFile"("zipUploadId");

-- CreateIndex
CREATE INDEX "ImageFolder_zipUploadId_idx" ON "ImageFolder"("zipUploadId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageFile_folderId_position_key" ON "ImageFile"("folderId", "position");

-- CreateIndex
CREATE INDEX "Assignment_workDate_idx" ON "Assignment"("workDate");

-- CreateIndex
CREATE INDEX "Assignment_userId_workDate_idx" ON "Assignment"("userId", "workDate");

-- CreateIndex
CREATE INDEX "Assignment_status_idx" ON "Assignment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentExcel_assignmentId_excelFileId_key" ON "AssignmentExcel"("assignmentId", "excelFileId");

-- CreateIndex
CREATE INDEX "AssignmentImageRange_imageFolderId_idx" ON "AssignmentImageRange"("imageFolderId");

-- CreateIndex
CREATE INDEX "Submission_assignmentId_idx" ON "Submission"("assignmentId");

-- CreateIndex
CREATE INDEX "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");

-- CreateIndex
CREATE INDEX "ActivityLog_action_idx" ON "ActivityLog"("action");

-- AddForeignKey
ALTER TABLE "ZipUpload" ADD CONSTRAINT "ZipUpload_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExcelFile" ADD CONSTRAINT "ExcelFile_zipUploadId_fkey" FOREIGN KEY ("zipUploadId") REFERENCES "ZipUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageFolder" ADD CONSTRAINT "ImageFolder_zipUploadId_fkey" FOREIGN KEY ("zipUploadId") REFERENCES "ZipUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImageFile" ADD CONSTRAINT "ImageFile_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "ImageFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_zipUploadId_fkey" FOREIGN KEY ("zipUploadId") REFERENCES "ZipUpload"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentExcel" ADD CONSTRAINT "AssignmentExcel_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentExcel" ADD CONSTRAINT "AssignmentExcel_excelFileId_fkey" FOREIGN KEY ("excelFileId") REFERENCES "ExcelFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentImageRange" ADD CONSTRAINT "AssignmentImageRange_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentImageRange" ADD CONSTRAINT "AssignmentImageRange_imageFolderId_fkey" FOREIGN KEY ("imageFolderId") REFERENCES "ImageFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
