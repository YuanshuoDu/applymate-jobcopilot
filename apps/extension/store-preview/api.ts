import { sampleDashboard, sampleFields, sampleProfile } from './fixtures'

// This module replaces the production API ONLY in the separate preview build.
// No fetch, login, AI generation, uploads, downloads or persistent writes occur.
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function getDashboard() { return structuredClone(sampleDashboard) }
export async function getPersona() { return { persona: sampleProfile.summaries.join('\n'), profile: structuredClone(sampleProfile) } }
export async function getPersonaFields() { return { fields: structuredClone(sampleFields) } }

export async function unavailable(): Promise<never> {
  throw new Error('Component preview only. Install ApplyMate and sign in to use this action.')
}

export const login = unavailable
export const saveJob = unavailable
export const getRecentJobs = unavailable
export const downloadApplicationPack = unavailable
export const openApplicationPackPrint = unavailable
export const updateJobStatus = unavailable
export const updateJobNotes = unavailable
export const updateJobScore = unavailable
export const updateJob = unavailable
export const getStats = unavailable
export const savePersonaFields = unavailable
export const deletePersonaField = unavailable
export const analyzeForm = unavailable
export const reviseFormFields = unavailable
export const listResumes = unavailable
export const getResume = unavailable
export const createResume = unavailable
export const updateResume = unavailable
export const tailorResume = unavailable
export const prepareApplicationPack = unavailable
export const deleteResume = unavailable
export const scoreResume = unavailable
export const scoreSavedJob = unavailable
export const suggestResume = unavailable
