import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { apiFetch, apiFetchRestoring } from "./api";
import { 
  FileText, 
  Link, 
  BookOpen, 
  FileCheck, 
  ExternalLink, 
  PlusCircle, 
  Trash2, 
  ChevronRight, 
  ShieldCheck, 
  ShieldAlert,
  Scale,
  MessageSquare,
  AlertCircle, 
  Sparkles, 
  Search, 
  Globe, 
  Video, 
  Mic, 
  Award,
  Layers,
  HelpCircle,
  Calendar,
  GraduationCap,
  Camera,
  UploadCloud,
  X,
  Eye,
  ImageIcon,
  Calculator,
  TrendingUp,
  Coins,
  Copy,
  Check,
  Download,
  Lightbulb,
  History,
  RotateCcw,
  Edit3,
  Languages,
  CheckCircle2,
  Wand2,
  Save,
  CheckCheck
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from "recharts";

interface VerifiedScholarlyCitation {
  title: string;
  author: string;
  year?: string;
  doi?: string;
  journalOrVenue?: string;
  citationsCount?: number;
  openAccessUrl?: string;
  isVerified?: boolean; // obsoleto
  verificationStatus?: VerificationStatus;
  supportVerdict?: SupportVerdict;
  supportQuote?: string;
  isRetracted?: boolean;
  hasConcern?: boolean;
  verificationNotes?: string[];
  link: string;
}

type VerificationStatus = "exact" | "probable" | "related_unverified" | "not_found";
type SupportVerdict = "supports" | "contradicts" | "mixed" | "unrelated" | "unassessed";

interface ScoutAssessment {
  whereAuthorIsRight: string[];
  strongestVersion: string;
  implicationsIfTrue: string[];
  whatWouldChangeTheConclusion: string[];
  evidenceSufficiency: "suficiente" | "parcial" | "insuficiente";
  sufficiencyNote?: string;
}

interface BibliographicSource {
  title: string;
  author: string;
  year?: string;
  type: string;
  link: string;
  summary: string;
  criticalAnalysis: string;
  reliabilityScore?: number | null; // null = no evaluable
  reliabilityBasis?: string[];
  academicRigor: string;
  doi?: string;
  journalOrVenue?: string;
  isVerified?: boolean; // obsoleto
  verificationStatus?: VerificationStatus;
  supportVerdict?: SupportVerdict;
  supportQuote?: string;
  isRetracted?: boolean;
  hasConcern?: boolean;
  verificationNotes?: string[];
  citationsCount?: number;
  openAccessUrl?: string;
  isRecent?: boolean;
  currencyReason?: string;
  currencyTag?: string;
}

interface CriticalPosition {
  title: string;
  argument: string;
  scientificBasis: string;
  targetClaim?: string;
  critiqueType?: string;
  evidenceThatWouldSettleIt?: string;
  suggestedSources?: string[];
  supportingStudy?: VerifiedScholarlyCitation;
  studyDiscardedNote?: string;
}

interface ConstructiveDebatesSummary {
  overview: string;
  keyQuestions: string[];
  consensusAndDisagreements?: string;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  simpleExample?: string;
  scientificEvidenceOrSource?: string;
  referenceUrl: string;
}

interface NumericalExample {
  concept: string;
  figureOrCost: string;
  explanation: string;
}

interface DataContrastItem {
  claimOrFact: string;
  officialVerification: string;
  status: "verified" | "corrected" | "clarified";
  reliableSource: string;
  sourceUrl?: string;
}

type ClaimVerdict = "supported" | "contradicted" | "partially_supported" | "insufficient_evidence" | "not_checkable";

interface ClaimCheck {
  id: string;
  claim: string;
  quote: string;
  quoteLocated: boolean;
  claimType: "fact" | "quantitative" | "attribution" | "prediction" | "opinion";
  verdict: ClaimVerdict;
  confidence: number;
  explanation: string;
  correction?: string;
  evidenceQuote?: string;
  evidence: Array<{ title: string; url: string }>;
  searchFailed?: boolean;
}

const CLAIM_VERDICT_UI: Record<ClaimVerdict, { label: string; chip: string }> = {
  supported: { label: "Respaldada", chip: "bg-emerald-100 text-emerald-900 border-emerald-300" },
  contradicted: { label: "Contradicha", chip: "bg-rose-100 text-rose-900 border-rose-300" },
  partially_supported: { label: "Parcialmente respaldada", chip: "bg-amber-100 text-amber-900 border-amber-300" },
  insufficient_evidence: { label: "Evidencia insuficiente", chip: "bg-slate-100 text-slate-700 border-slate-300" },
  not_checkable: { label: "No comprobable (opinión o predicción)", chip: "bg-slate-50 text-slate-500 border-slate-200" },
};

const VERIFICATION_UI: Record<VerificationStatus, { label: string; tone: string }> = {
  exact: { label: "Cita verificada: la obra existe y coincide con el registro", tone: "text-emerald-800" },
  probable: { label: "Coincidencia probable con el registro (sin DOI comprobado)", tone: "text-amber-800" },
  related_unverified: { label: "Lectura relacionada: sugerida por búsqueda automática, NO verificada como fuente de esta afirmación", tone: "text-slate-700" },
  not_found: { label: "No localizada en registros académicos", tone: "text-rose-800" },
};
const SUPPORT_UI: Record<SupportVerdict, string> = {
  supports: "Su resumen respalda la afirmación",
  contradicts: "Su resumen contradice la afirmación",
  mixed: "Su resumen la respalda solo en parte",
  unrelated: "Su resumen no trata esta afirmación",
  unassessed: "Respaldo no comprobado (sin resumen disponible o sin prueba literal)",
};
const CRITIQUE_TYPE_LABEL: Record<string, string> = {
  definicion_perimetro: "Definición y perímetro de las cifras",
  medicion: "Medición",
  causal: "Causalidad",
  institucional_contable: "Marco institucional o contable",
  empirica: "Evidencia empírica",
  logica: "Lógica del argumento",
  normativa: "Juicio normativo",
};

interface FactCheckAudit {
  auditedAt: string;
  status: "verified" | "corrected" | "inconclusive";
  method?: "claim_level_v2";
  auditedFrom?: "original_text" | "summary_only";
  claimChecks?: ClaimCheck[];
  counts?: Record<ClaimVerdict, number>;
  coverage?: { searchFailed?: number };
  previousExecutiveSummary?: string;
  previousKeyPoints?: string[];
  verdictTitle?: string;
  summaryAudit: string;
  detectedErrors: string[];
  correctionsApplied: string[];
  contrastTable?: DataContrastItem[];
  verifiedSources: Array<{ title: string; url: string; snippet?: string; reliability?: string }>;
  userFeedback?: string;
}

interface AnalysisResult {
  id: string;
  url: string;
  title: string;
  originalLanguage: string;
  outputLanguage?: string;
  isSpanishOrGalician: boolean;
  categories: string[];
  translation?: string;
  originalExtractedText?: string;
  executiveSummary: string;
  keyPoints: string[];
  numericalExamples?: NumericalExample[];
  academicDebates?: string;
  criticalPositions?: CriticalPosition[];
  constructiveDebatesSummary?: ConstructiveDebatesSummary;
  glossary?: GlossaryTerm[];
  bibliographicSources: BibliographicSource[];
  analyzedAt: string;
  contentType: "blog" | "podcast" | "youtube" | "manual" | "photo" | "document";
  photoUrls?: string[];
  fileNames?: string[];
  overallReliabilityScore?: number | null;
  scoutAssessment?: ScoutAssessment;
  factCheckAudit?: FactCheckAudit;
  isEditedManually?: boolean;
}

interface UploadedFile {
  id: string;
  name: string;
  size: number;
  type: "image" | "pdf" | "word" | "other";
  mimeType: string;
  dataUrl: string;
}

export default function App() {
  const [url, setUrl] = useState("");
  const [manualText, setManualText] = useState("");
  const [contentType, setContentType] = useState<"blog" | "podcast" | "youtube" | "manual" | "photo" | "document">("blog");
  const [activeTab, setActiveTab] = useState<"url" | "photo" | "manual">("url");
  const [selectedFiles, setSelectedFiles] = useState<UploadedFile[]>([]);
  const [photoNote, setPhotoNote] = useState("");
  const [viewingPhoto, setViewingPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  
  // Eagerly initialize analyses and selectedAnalysis from localStorage for instant rendering
  const [analyses, setAnalyses] = useState<AnalysisResult[]>(() => {
    try {
      const saved = localStorage.getItem("lupa_critica_history");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  });
  
  const [selectedAnalysis, setSelectedAnalysis] = useState<AnalysisResult | null>(() => {
    try {
      const saved = localStorage.getItem("lupa_critica_history");
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
      }
    } catch {}
    return null;
  });

  const [error, setError] = useState<string | null>(null);
  const [copiedNotion, setCopiedNotion] = useState(false);
  const [translationCopied, setTranslationCopied] = useState(false);
  const [isTranslatingFull, setIsTranslatingFull] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [showClearAllModal, setShowClearAllModal] = useState(false);

  // Fact-checking, Live Web Grounded Consultation & Correction states
  const [isAuditing, setIsAuditing] = useState(false);
  const [isApplyingCorrection, setIsApplyingCorrection] = useState(false);
  const [isSwitchingLanguage, setIsSwitchingLanguage] = useState(false);
  const [showCorrectionModal, setShowCorrectionModal] = useState(false);
  const [userCorrectionText, setUserCorrectionText] = useState("");
  const [correctionWebCheck, setCorrectionWebCheck] = useState(true);
  const [correctionTargetLang, setCorrectionTargetLang] = useState<string>("");

  // In-place direct editing mode
  const [isDirectEditMode, setIsDirectEditMode] = useState(false);
  const [editableSummary, setEditableSummary] = useState("");
  const [editableKeyPoints, setEditableKeyPoints] = useState<string[]>([]);
  const [isSavingManualEdit, setIsSavingManualEdit] = useState(false);

  // Sync direct editing inputs when selected analysis changes
  useEffect(() => {
    if (selectedAnalysis) {
      setEditableSummary(selectedAnalysis.executiveSummary || "");
      setEditableKeyPoints(selectedAnalysis.keyPoints ? [...selectedAnalysis.keyPoints] : []);
      setIsDirectEditMode(false);
    }
  }, [selectedAnalysis?.id]);

  const handleAutoFactCheck = async () => {
    if (!selectedAnalysis) return;
    setIsAuditing(true);
    setError(null);

    try {
      const res = await apiFetchRestoring(selectedAnalysis, `/api/analyses/${selectedAnalysis.id}/auto-factcheck`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Non se puido completar a auditoría e verificación coa web.");
      }

      const updated: AnalysisResult = await res.json();
      setSelectedAnalysis(updated);
      setAnalyses(prev => {
        const next = prev.map(item => item.id === updated.id ? updated : item);
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(next));
        } catch {}
        return next;
      });
      setEditableSummary(updated.executiveSummary || "");
      setEditableKeyPoints(updated.keyPoints ? [...updated.keyPoints] : []);
    } catch (err: any) {
      console.error("Error en auto fact-check:", err);
      setError(err.message || "Erro durante a verificación automática na web.");
    } finally {
      setIsAuditing(false);
    }
  };

  const handleApplyUserCorrection = async () => {
    if (!selectedAnalysis || !userCorrectionText.trim()) return;
    setIsApplyingCorrection(true);
    setError(null);

    try {
      const res = await apiFetchRestoring(selectedAnalysis, `/api/analyses/${selectedAnalysis.id}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userCorrection: userCorrectionText.trim(),
          checkWithWeb: correctionWebCheck,
          targetLanguage: correctionTargetLang || undefined
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Non se puido procesar a corrección.");
      }

      const updated: AnalysisResult = await res.json();
      setSelectedAnalysis(updated);
      setAnalyses(prev => {
        const next = prev.map(item => item.id === updated.id ? updated : item);
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(next));
        } catch {}
        return next;
      });
      setEditableSummary(updated.executiveSummary || "");
      setEditableKeyPoints(updated.keyPoints ? [...updated.keyPoints] : []);
      setShowCorrectionModal(false);
      setUserCorrectionText("");
    } catch (err: any) {
      console.error("Error al aplicar corrección:", err);
      setError(err.message || "Erro ao aplicar a corrección.");
    } finally {
      setIsApplyingCorrection(false);
    }
  };

  const handleSaveDirectEdit = async () => {
    if (!selectedAnalysis) return;
    setIsSavingManualEdit(true);
    setError(null);

    try {
      const res = await apiFetchRestoring(selectedAnalysis, `/api/analyses/${selectedAnalysis.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executiveSummary: editableSummary,
          keyPoints: editableKeyPoints
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Error al guardar los cambios.");
      }

      const updated: AnalysisResult = await res.json();
      setSelectedAnalysis(updated);
      setAnalyses(prev => {
        const next = prev.map(item => item.id === updated.id ? updated : item);
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(next));
        } catch {}
        return next;
      });
      setIsDirectEditMode(false);
    } catch (err: any) {
      console.error("Error al guardar edición manual:", err);
      setError(err.message || "Error al guardar los cambios.");
    } finally {
      setIsSavingManualEdit(false);
    }
  };

  const handleSwitchLanguage = async (targetLang: string) => {
    if (!selectedAnalysis || isSwitchingLanguage) return;
    setIsSwitchingLanguage(true);
    setError(null);

    try {
      const res = await apiFetchRestoring(selectedAnalysis, `/api/analyses/${selectedAnalysis.id}/switch-language`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetLanguage: targetLang })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "Error al cambiar el idioma del informe.");
      }

      const updated: AnalysisResult = await res.json();
      setSelectedAnalysis(updated);
      setAnalyses(prev => {
        const next = prev.map(item => item.id === updated.id ? updated : item);
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(next));
        } catch {}
        return next;
      });
      setEditableSummary(updated.executiveSummary || "");
      setEditableKeyPoints(updated.keyPoints ? [...updated.keyPoints] : []);
    } catch (err: any) {
      console.error("Error al cambiar idioma:", err);
      setError(err.message || "Error al cambiar el idioma.");
    } finally {
      setIsSwitchingLanguage(false);
    }
  };

  const handleRequestFullTranslation = async (analysisToTranslate?: AnalysisResult) => {
    const target = analysisToTranslate || selectedAnalysis;
    if (!target) return;

    setIsTranslatingFull(true);
    setError(null);

    try {
      const res = await apiFetch("/api/full-translation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          analysisId: target.id,
          rawText: target.originalExtractedText,
          url: target.url,
          title: target.title,
          originalLanguage: target.originalLanguage
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "No se pudo generar la traducción íntegra.");
      }

      const data = await res.json();
      const updated: AnalysisResult = {
        ...target,
        translation: data.fullTranslation,
        isSpanishOrGalician: false
      };

      setSelectedAnalysis(updated);
      setAnalyses(prev => {
        const next = prev.map(item => item.id === target.id ? updated : item);
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(next));
        } catch {}
        return next;
      });
    } catch (err: any) {
      console.error("Error al traducir íntegramente:", err);
      setError(err.message || "Error al solicitar la traducción completa.");
    } finally {
      setIsTranslatingFull(false);
    }
  };

  const handleCopyTranslation = (text: string) => {
    navigator.clipboard.writeText(text);
    setTranslationCopied(true);
    setTimeout(() => setTranslationCopied(false), 2000);
  };

  const handleDownloadTranslation = (title: string, text: string) => {
    const blob = new Blob([`TRADUCCIÓN E HISTORIAL DE ANÁLISIS - LUPA CRÍTICA\nTítulo: ${title}\nFecha: ${new Date().toLocaleString()}\n\n=========================================\nTRADUCCIÓN ÍNTEGRA Y EXHAUSTIVA AL CASTELLANO\n=========================================\n\n${text}`], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Traduccion_Integra_${title.replace(/[^a-z0-9]/gi, '_').substring(0, 35)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Fetch past analyses on load & sync with localStorage
  useEffect(() => {
    fetchAnalyses();
  }, []);

  const fetchAnalyses = async () => {
    try {
      const res = await apiFetch("/api/analyses");
      if (res.ok) {
        const serverData: AnalysisResult[] = await res.json();
        
        // Merge with localStorage
        let localData: AnalysisResult[] = [];
        try {
          const saved = localStorage.getItem("lupa_critica_history");
          if (saved) localData = JSON.parse(saved);
        } catch {
          // ignore
        }

        const map = new Map<string, AnalysisResult>();
        serverData.forEach((item) => map.set(item.id, item));
        localData.forEach((item) => {
          if (!map.has(item.id)) map.set(item.id, item);
        });

        const combined = Array.from(map.values()).sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
        setAnalyses(combined);
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(combined));
        } catch {}

        setSelectedAnalysis((current) => {
          if (!current && combined.length > 0) return combined[0];
          if (current && !combined.some((item) => item.id === current.id)) {
            return combined.length > 0 ? combined[0] : null;
          }
          return current;
        });
      }
    } catch (err) {
      console.error("Error al cargar históricos desde el servidor:", err);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file: File) => {
      const fileName = file.name;
      const lowerName = fileName.toLowerCase();
      let fileType: "image" | "pdf" | "word" | "other" = "other";

      if (file.type.startsWith("image/")) {
        fileType = "image";
      } else if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
        fileType = "pdf";
      } else if (
        file.type.includes("word") ||
        file.type.includes("officedocument") ||
        file.type.includes("msword") ||
        lowerName.endsWith(".docx") ||
        lowerName.endsWith(".doc")
      ) {
        fileType = "word";
      } else {
        fileType = "other";
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          const newFile: UploadedFile = {
            id: "file_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6),
            name: fileName,
            size: file.size,
            type: fileType,
            mimeType: file.type || (fileType === "pdf" ? "application/pdf" : fileType === "word" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "image/jpeg"),
            dataUrl: event.target!.result as string
          };
          setSelectedFiles((prev) => [...prev, newFile]);
        }
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  };

  const removeFile = (id: string) => {
    setSelectedFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const startAnalysis = async (targetUrl?: string, directText?: string, directFiles?: UploadedFile[]) => {
    setLoading(true);
    setError(null);
    
    const filesToUse = directFiles !== undefined ? directFiles : (activeTab === "photo" ? selectedFiles : []);
    const hasDocs = filesToUse.some(f => f.type === "pdf" || f.type === "word");
    const isPhotoTab = activeTab === "photo" || filesToUse.length > 0;

    const steps = hasDocs ? [
      "Iniciando procesador de documentos PDF y Word (.docx)...",
      "Extrayendo cuerpo de texto, tablas, epígrafes y metadatos...",
      "Analizando el contenido del informe e identificando el idioma...",
      "Traduciendo y adaptando conceptos clave al castellano...",
      "Generando resumen ejecutivo y posiciones críticas universitarias...",
      "Contrastando fuentes en registros de revisión por pares (OpenAlex, Crossref)...",
      "Verificando citas indexadas en Google Scholar y repositorios académicos..."
    ] : isPhotoTab ? [
      "Iniciando escaneo visual y motor OCR en la fotografía...",
      "Extrayendo titulares, columnas y gráficos del recorte de prensa...",
      "Analizando el contenido de la imagen e identificando el idioma...",
      "Traduciendo y adaptando conceptos clave al castellano...",
      "Generando resumen ejecutivo y posiciones críticas universitarias...",
      "Contrastando fuentes en registros de revisión por pares (OpenAlex, Crossref)...",
      "Verificando citas indexadas en Google Scholar y repositorios académicos..."
    ] : [
      "Iniciando raspado y extracción de datos del recurso...",
      "Analizando la estructura y el idioma del contenido original...",
      "Traduciendo y adaptando conceptos clave al castellano...",
      "Generando resumen ejecutivo y destilando puntos clave...",
      "Contrastando fuentes en registros de revisión por pares (OpenAlex, Crossref)...",
      "Verificando citas indexadas en Google Scholar y repositorios académicos...",
      "Evaluando el rigor académico y calculando índices de credibilidad..."
    ];

    let stepIndex = 0;
    setLoadingStep(steps[0]);
    const stepInterval = setInterval(() => {
      if (stepIndex < steps.length - 1) {
        stepIndex++;
        setLoadingStep(steps[stepIndex]);
      }
    }, 4500);

    try {
      const payload = {
        url: targetUrl !== undefined ? targetUrl : (activeTab === "url" ? url : ""),
        manualText: directText !== undefined ? directText : (activeTab === "manual" ? manualText : (activeTab === "photo" ? photoNote : "")),
        contentType: targetUrl ? "blog" : (targetUrl?.includes("youtube") || url.includes("youtube") ? "youtube" : (hasDocs ? "document" : (isPhotoTab ? "photo" : contentType))),
        files: filesToUse.map(f => ({ name: f.name, type: f.mimeType, data: f.dataUrl })),
        images: filesToUse.filter(f => f.type === "image").map(f => f.dataUrl)
      };

      const res = await apiFetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      let responseData: any;
      const responseText = await res.text();
      try {
        responseData = JSON.parse(responseText);
      } catch {
        throw new Error(`El servidor devolvió una respuesta no válida (${res.status}). Por favor, reintenta en unos instantes.`);
      }

      if (!res.ok) {
        throw new Error(responseData?.error || `Error del servidor (${res.status}).`);
      }

      const result: AnalysisResult = responseData;
      
      // Update states and localStorage
      setAnalyses(prev => {
        const updated = [result, ...prev.filter(i => i.id !== result.id)];
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(updated));
        } catch {}
        return updated;
      });
      setSelectedAnalysis(result);
      
      // Reset inputs
      if (activeTab === "manual") setManualText("");
      if (activeTab === "url" && !targetUrl) setUrl("");
      if (activeTab === "photo") {
        setSelectedFiles([]);
        setPhotoNote("");
      }

    } catch (err: any) {
      setError(err.message || "Ocurrió un error inesperado al realizar el análisis.");
    } finally {
      clearInterval(stepInterval);
      setLoading(false);
      setLoadingStep("");
    }
  };

  const requestDeleteAnalysis = (id: string, title: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setDeleteTarget({ id, title });
  };

  const executeDelete = async (id: string) => {
    // Optimistic removal from state and local storage
    setAnalyses((prev) => {
      const updated = prev.filter((item) => item.id !== id);
      try {
        localStorage.setItem("lupa_critica_history", JSON.stringify(updated));
      } catch {}
      return updated;
    });

    setSelectedAnalysis((current) => {
      if (current?.id === id) {
        const remaining = analyses.filter((item) => item.id !== id);
        return remaining.length > 0 ? remaining[0] : null;
      }
      return current;
    });

    setDeleteTarget(null);

    try {
      await apiFetch(`/api/analyses/${id}`, { method: "DELETE" });
    } catch (err) {
      console.error("Error al sincronizar borrado con el servidor:", err);
    }
  };

  const executeClearAll = async () => {
    setAnalyses([]);
    setSelectedAnalysis(null);
    setShowClearAllModal(false);
    try {
      localStorage.removeItem("lupa_critica_history");
      await apiFetch("/api/analyses", { method: "DELETE", headers: { "X-Confirm-Delete-All": "yes" } });
    } catch (err) {
      console.error("Error al vaciar histórico:", err);
    }
  };

  // Helper to get score color
  const getScoreColor = (score?: number | null) => {
    if (typeof score !== "number") return "text-slate-500 bg-slate-50 border-slate-200";
    if (score >= 80) return "text-emerald-600 bg-emerald-50 border-emerald-200";
    if (score >= 60) return "text-amber-600 bg-amber-50 border-amber-200";
    return "text-rose-600 bg-rose-50 border-rose-200";
  };

  const getProgressBarColor = (score?: number | null) => {
    if (typeof score !== "number") return "bg-slate-300";
    if (score >= 80) return "bg-emerald-600";
    if (score >= 60) return "bg-amber-500";
    return "bg-rose-500";
  };

  const getContentTypeIcon = (type: string) => {
    switch (type) {
      case "youtube": return <Video className="w-4 h-4 text-rose-500" />;
      case "podcast": return <Mic className="w-4 h-4 text-purple-500" />;
      case "blog": return <FileText className="w-4 h-4 text-blue-500" />;
      case "photo": return <Camera className="w-4 h-4 text-emerald-600" />;
      case "document": return <FileText className="w-4 h-4 text-amber-600" />;
      default: return <FileText className="w-4 h-4 text-slate-500" />;
    }
  };

  const sanitizeFilename = (title: string): string => {
    return (
      title
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "analisis-lupa-critica"
    );
  };

  const generateNotionMarkdown = (analysis: AnalysisResult): string => {
    let md = `# ${analysis.title}\n\n`;

    // Metadata section
    md += `> **Metadatos del Análisis**\n`;
    if (analysis.url) {
      md += `> - **Recurso Original:** [${analysis.url}](${analysis.url})\n`;
    }
    md += `> - **Tipo de Contenido:** ${analysis.contentType}\n`;
    if (analysis.categories && analysis.categories.length > 0) {
      md += `> - **Categorías:** ${analysis.categories.join(", ")}\n`;
    }
    md += `> - **Idioma Original:** ${analysis.originalLanguage}\n`;
    if (analysis.analyzedAt) {
      md += `> - **Fecha de Análisis:** ${new Date(analysis.analyzedAt).toLocaleString("es-ES")}\n`;
    }
    if (analysis.fileNames && analysis.fileNames.length > 0) {
      md += `> - **Archivos Analizados:** ${analysis.fileNames.join(", ")}\n`;
    }
    md += `\n---\n\n`;

    // 1. Resumen Ejecutivo
    md += `## Resumen Ejecutivo\n\n${analysis.executiveSummary.trim()}\n\n`;

    // 2. Puntos Clave
    if (analysis.keyPoints && analysis.keyPoints.length > 0) {
      md += `## Puntos Clave\n\n`;
      analysis.keyPoints.forEach((point, i) => {
        md += `- **Punto ${i + 1}:** ${point}\n`;
      });
      md += `\n`;
    }

    // 3. Ejemplos Numéricos, Costes y Cifras Reales
    if (analysis.numericalExamples && analysis.numericalExamples.length > 0) {
      md += `## Ejemplos Numéricos, Costes y Cifras Reales\n\n`;
      analysis.numericalExamples.forEach((item) => {
        md += `### ${item.concept} — \`${item.figureOrCost}\`\n\n`;
        md += `${item.explanation}\n\n`;
      });
    }

    // 4. Posiciones Críticas Científica y Metodológicamente Fundamentadas
    if (analysis.criticalPositions && analysis.criticalPositions.length > 0) {
      md += `## Posiciones Críticas Científica y Metodológicamente Fundamentadas\n\n`;
      analysis.criticalPositions.forEach((crit, i) => {
        md += `### Posición ${i + 1}: ${crit.title}\n\n`;
        md += `- **Argumento:** ${crit.argument}\n`;
        md += `- **Fundamento Científico/Empírico:** ${crit.scientificBasis}\n`;
        if (crit.targetClaim) md += `- **Se refiere a:** «${crit.targetClaim}»\n`;
        if (crit.evidenceThatWouldSettleIt) md += `- **Qué evidencia lo resolvería:** ${crit.evidenceThatWouldSettleIt}${crit.suggestedSources?.length ? ` (consultar: ${crit.suggestedSources.join("; ")})` : ""}\n`;
        if (crit.studyDiscardedNote) md += `- _${crit.studyDiscardedNote}_\n`;
        if (crit.supportingStudy) {
          md += `- **Estado de la cita:** ${VERIFICATION_UI[crit.supportingStudy.verificationStatus ?? "not_found"].label}${crit.supportingStudy.supportVerdict ? ` · ${SUPPORT_UI[crit.supportingStudy.supportVerdict]}` : ""}\n`;
          if (crit.supportingStudy.supportQuote) md += `- **Frase del resumen:** «${crit.supportingStudy.supportQuote}»\n`;
          md += `- **Estudio:** _${crit.supportingStudy.title}_ — ${crit.supportingStudy.author}${crit.supportingStudy.year ? ` (${crit.supportingStudy.year})` : ""}\n`;
          if (crit.supportingStudy.journalOrVenue) md += `  - **Revista / Editorial:** ${crit.supportingStudy.journalOrVenue}\n`;
          if (crit.supportingStudy.doi) md += `  - **DOI Oficial:** [${crit.supportingStudy.doi}](${crit.supportingStudy.doi})\n`;
          if (crit.supportingStudy.citationsCount) md += `  - **Citas Registradas:** ${crit.supportingStudy.citationsCount}\n`;
          if (crit.supportingStudy.link) md += `  - **Google Scholar:** [Consultar en Google Scholar](${crit.supportingStudy.link})\n`;
        }
        md += `\n`;
      });
    }

    // 5. Debates Constructivos en Curso y Consensos
    if (analysis.constructiveDebatesSummary) {
      md += `## Debates Constructivos en Curso y Consensos\n\n`;
      if (analysis.constructiveDebatesSummary.overview) {
        md += `### Estado General de la Discusión\n\n${analysis.constructiveDebatesSummary.overview}\n\n`;
      }
      if (analysis.constructiveDebatesSummary.consensusAndDisagreements) {
        md += `### Consensos y Puntos de Desacuerdo Lógico\n\n${analysis.constructiveDebatesSummary.consensusAndDisagreements}\n\n`;
      }
      if (analysis.constructiveDebatesSummary.keyQuestions && analysis.constructiveDebatesSummary.keyQuestions.length > 0) {
        md += `### Preguntas Abiertas y Dilemas Clave\n\n`;
        analysis.constructiveDebatesSummary.keyQuestions.forEach((q) => {
          md += `- ${q}\n`;
        });
        md += `\n`;
      }
    }

    // 6. Debates Académicos e Intelectuales
    if (analysis.academicDebates) {
      md += `## Debates Académicos e Intelectuales\n\n${analysis.academicDebates.trim()}\n\n`;
    }

    // 7. Glosario Didáctico de Conceptos Complejos
    if (analysis.glossary && analysis.glossary.length > 0) {
      md += `## Glosario Didáctico de Conceptos Complejos\n\n`;
      analysis.glossary.forEach((term, idx) => {
        md += `### ${idx + 1}. ${term.term}\n\n`;
        md += `- **Definición:** ${term.definition}\n`;
        if (term.simpleExample) {
          md += `- **Ejemplo Práctico y Precedente Histórico / Caso Real:** ${term.simpleExample}\n`;
        }
        if (term.scientificEvidenceOrSource) {
          md += `- **Evidencia Científica y Fuente Probada:** ${term.scientificEvidenceOrSource}\n`;
        }
        if (term.referenceUrl) {
          md += `- **Referencia Académica:** [Consultar en Repositorio Oficial](${term.referenceUrl})\n`;
        }
        md += `\n`;
      });
    }

    // 8. Transcripción y Traducción Exhaustiva al Castellano (si aplica)
    if (analysis.translation) {
      md += `## Transcripción y Traducción Exhaustiva al Castellano\n\n${analysis.translation.trim()}\n\n`;
    }

    // 9. Fuentes Bibliográficas e Investigación Secundaria Verificada
    if (analysis.bibliographicSources && analysis.bibliographicSources.length > 0) {
      md += `## Fuentes bibliográficas (con estado de verificación)\n\n`;
      analysis.bibliographicSources.forEach((src, idx) => {
        md += `### ${idx + 1}. ${src.title}\n\n`;
        md += `- **Autor/es:** ${src.author}\n`;
        if (src.year) md += `- **Año:** ${src.year}\n`;
        if (src.journalOrVenue) md += `- **Revista / Editorial:** ${src.journalOrVenue}\n`;
        if (src.doi) md += `- **DOI:** [${src.doi}](${src.doi})\n`;
        md += `- **Tipo:** ${src.type}\n`;
        if (src.citationsCount !== undefined && src.citationsCount !== null) md += `- **Citas Registradas:** ${src.citationsCount}\n`;
        md += `- **Estado de la cita:** ${VERIFICATION_UI[src.verificationStatus ?? "not_found"].label}${src.supportVerdict ? ` · ${SUPPORT_UI[src.supportVerdict]}` : ""}\n`;
        md += `- **Fiabilidad (rúbrica):** ${typeof src.reliabilityScore === "number" ? `${src.reliabilityScore}/100` : "no evaluable"}\n`;
        md += `- **Base de la valoración:** ${src.academicRigor}\n`;
        if (src.link) md += `- **Búsqueda Google Scholar:** [Ver en Google Scholar](${src.link})\n`;
        md += `\n**Sinopsis y Contribución:**\n${src.summary}\n\n`;
        md += `**Análisis Crítico y Contraste:**\n_${src.criticalAnalysis}_\n\n`;
      });
    }

    return md;
  };

  const handleCopyNotion = async (target?: AnalysisResult) => {
    const analysisToUse = target || selectedAnalysis;
    if (!analysisToUse) return;
    const md = generateNotionMarkdown(analysisToUse);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(md);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = md;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopiedNotion(true);
      setTimeout(() => setCopiedNotion(false), 2200);
    } catch (err) {
      console.error("Error al copiar al portapapeles:", err);
    }
  };

  const handleDownloadMarkdown = (target?: AnalysisResult) => {
    const analysisToUse = target || selectedAnalysis;
    if (!analysisToUse) return;
    const md = generateNotionMarkdown(analysisToUse);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = downloadUrl;
    a.download = `${sanitizeFilename(analysisToUse.title)}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-slate-200">
      {/* Top Professional Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-50 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 py-3 sm:px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-slate-900 text-white rounded-lg shadow-sm">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-display font-bold tracking-tight text-slate-900 flex items-center gap-2">
                Lupa Crítica <span className="text-xs font-mono font-medium px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full border border-slate-200">Verificador Académico</span>
              </h1>
              <p className="text-xs text-slate-500">Deconstrucción, traducción y verificación de fuentes para blogs, podcasts y vídeos científicos o de divulgación.</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2.5">
            {selectedAnalysis && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleCopyNotion()}
                  className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all font-medium border shadow-xs cursor-pointer ${
                    copiedNotion
                      ? "bg-emerald-600 text-white border-emerald-700 shadow-sm"
                      : "bg-white text-slate-800 border-slate-300 hover:bg-slate-50 hover:border-slate-400 hover:text-slate-900"
                  }`}
                  title="Copiar informe activo en formato Markdown para Notion"
                >
                  {copiedNotion ? <Check className="w-3.5 h-3.5 text-white" /> : <Copy className="w-3.5 h-3.5 text-indigo-600" />}
                  <span>{copiedNotion ? "¡Copiado para Notion!" : "Copiar Notion"}</span>
                </button>

                <button
                  onClick={() => handleDownloadMarkdown()}
                  className="text-xs text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 hover:border-slate-400 hover:text-slate-900 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all font-medium shadow-xs cursor-pointer"
                  title="Descargar análisis como archivo .md para importar a Notion"
                >
                  <Download className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Descargar .md</span>
                </button>
              </div>
            )}

            <span className="text-xs font-mono text-slate-500 bg-slate-100 px-2.5 py-1.5 rounded-md border border-slate-200 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              {analyses.length > 0 ? `${analyses.length} en Histórico` : "Gabinete Listo"}
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        
        {/* Outer Bento Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          
          {/* Left Column (Forms & History list): 4/12 width */}
          <div className="lg:col-span-4 flex flex-col gap-6">
            
            {/* Input Panel */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
              <h2 className="text-base font-display font-semibold text-slate-900 mb-4 flex items-center gap-2">
                <PlusCircle className="w-5 h-5 text-slate-700" />
                Nuevo Análisis
              </h2>

              {/* URL vs Archivos/Fotos vs Manual Tabs */}
              <div className="flex border-b border-slate-100 mb-4">
                <button
                  onClick={() => { setActiveTab("url"); setContentType("blog"); }}
                  className={`flex-1 pb-2.5 text-xs font-medium border-b-2 text-center transition-all cursor-pointer ${
                    activeTab === "url" 
                      ? "border-slate-900 text-slate-900 font-semibold" 
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  Analizar URL
                </button>
                <button
                  onClick={() => { setActiveTab("photo"); setContentType("document"); }}
                  className={`flex-1 pb-2.5 text-xs font-medium border-b-2 text-center transition-all cursor-pointer flex items-center justify-center gap-1.5 ${
                    activeTab === "photo" 
                      ? "border-slate-900 text-slate-900 font-semibold" 
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  <UploadCloud className="w-3.5 h-3.5 text-amber-600" />
                  Archivos / Fotos
                </button>
                <button
                  onClick={() => { setActiveTab("manual"); setContentType("manual"); }}
                  className={`flex-1 pb-2.5 text-xs font-medium border-b-2 text-center transition-all cursor-pointer ${
                    activeTab === "manual" 
                      ? "border-slate-900 text-slate-900 font-semibold" 
                      : "border-transparent text-slate-400 hover:text-slate-600"
                  }`}
                >
                  Texto Manual
                </button>
              </div>

              {activeTab === "url" ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">URL del Contenido</label>
                    <div className="relative">
                      <input
                        type="url"
                        placeholder="Ej: https://substack.com/... o enlace de YouTube"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 focus:bg-white transition-all text-slate-800"
                      />
                      <Link className="absolute left-3 top-2.5 w-4 h-4 text-slate-400" />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Tipo de Canal / Formato</label>
                    <div className="grid grid-cols-3 gap-2">
                      <button
                        type="button"
                        onClick={() => setContentType("blog")}
                        className={`py-2 text-xs font-medium rounded-lg border transition-all flex flex-col items-center gap-1 cursor-pointer ${
                          contentType === "blog"
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 hover:bg-slate-50 text-slate-600"
                        }`}
                      >
                        <FileText className="w-4 h-4" />
                        Blog/Substack
                      </button>
                      <button
                        type="button"
                        onClick={() => setContentType("podcast")}
                        className={`py-2 text-xs font-medium rounded-lg border transition-all flex flex-col items-center gap-1 cursor-pointer ${
                          contentType === "podcast"
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 hover:bg-slate-50 text-slate-600"
                        }`}
                      >
                        <Mic className="w-4 h-4" />
                        Podcast/Audio
                      </button>
                      <button
                        type="button"
                        onClick={() => setContentType("youtube")}
                        className={`py-2 text-xs font-medium rounded-lg border transition-all flex flex-col items-center gap-1 cursor-pointer ${
                          contentType === "youtube"
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-200 hover:bg-slate-50 text-slate-600"
                        }`}
                      >
                        <Video className="w-4 h-4" />
                        YouTube
                      </button>
                    </div>
                  </div>
                </div>
              ) : activeTab === "photo" ? (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5 flex items-center justify-between">
                      <span>Subir Documentos o Fotos</span>
                      <span className="text-[10px] text-slate-400 font-mono">PDF, DOCX, DOC, JPG, PNG</span>
                    </label>
                    
                    <div className="border-2 border-dashed border-slate-200 hover:border-slate-400 rounded-xl p-4 transition-all text-center bg-slate-50/60 relative group">
                      <input
                        type="file"
                        accept="image/*, .pdf, .doc, .docx, application/pdf, application/msword, application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                        multiple
                        onChange={handleFileUpload}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                      />
                      <div className="flex flex-col items-center justify-center gap-2 pointer-events-none">
                        <div className="p-2.5 bg-amber-50 text-amber-600 rounded-full group-hover:scale-105 transition-all">
                          <UploadCloud className="w-6 h-6" />
                        </div>
                        <div>
                          <span className="text-xs font-semibold text-slate-800 block">
                            Haz clic o arrastra para subir tus archivos
                          </span>
                          <span className="text-[11px] text-slate-500 block mt-0.5">
                            Admite archivos PDF, Word (.docx / .doc), fotos de periódicos o prensa
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* File List Previews */}
                    {selectedFiles.length > 0 && (
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-slate-700 flex items-center gap-1">
                            <UploadCloud className="w-3.5 h-3.5 text-slate-500" />
                            {selectedFiles.length} archivo(s) adjunto(s):
                          </span>
                          <button
                            type="button"
                            onClick={() => setSelectedFiles([])}
                            className="text-[11px] text-rose-600 hover:underline cursor-pointer"
                          >
                            Eliminar todos
                          </button>
                        </div>
                        <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                          {selectedFiles.map((file) => {
                            const sizeFormatted = file.size > 1024 * 1024 
                              ? `${(file.size / (1024 * 1024)).toFixed(1)} MB` 
                              : `${Math.round(file.size / 1024)} KB`;
                            
                            return (
                              <div key={file.id} className="flex items-center justify-between p-2 bg-white border border-slate-200 rounded-lg text-xs shadow-2xs">
                                <div className="flex items-center gap-2 truncate pr-2">
                                  {file.type === "pdf" ? (
                                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-rose-100 text-rose-700 rounded font-mono shrink-0">PDF</span>
                                  ) : file.type === "word" ? (
                                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-700 rounded font-mono shrink-0">WORD</span>
                                  ) : file.type === "image" ? (
                                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-emerald-100 text-emerald-700 rounded font-mono shrink-0">FOTO</span>
                                  ) : (
                                    <span className="px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 rounded font-mono shrink-0">FILE</span>
                                  )}
                                  <span className="font-medium text-slate-800 truncate">{file.name}</span>
                                  <span className="text-[10px] text-slate-400 font-mono shrink-0">({sizeFormatted})</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removeFile(file.id)}
                                  className="p-1 text-slate-400 hover:text-rose-600 transition-all cursor-pointer shrink-0"
                                  title="Eliminar archivo"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">
                      Notas o Contexto Opcional
                    </label>
                    <input
                      type="text"
                      placeholder="Ej: 'Informe de investigación económica o artículo de prensa sobre sanidad'"
                      value={photoNote}
                      onChange={(e) => setPhotoNote(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 focus:bg-white transition-all text-slate-800"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1.5">Pegar Texto o Transcripción Completa</label>
                    <textarea
                      rows={6}
                      placeholder="Pega el manuscrito, blog, o transcripción extraída para iniciar el desglose crítico..."
                      value={manualText}
                      onChange={(e) => setManualText(e.target.value)}
                      className="w-full p-3 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-900 focus:bg-white transition-all text-slate-800"
                    />
                  </div>
                </div>
              )}

              <button
                onClick={() => startAnalysis()}
                disabled={loading || (activeTab === "url" ? !url : activeTab === "photo" ? selectedFiles.length === 0 : !manualText)}
                className="w-full mt-5 py-2.5 bg-slate-950 hover:bg-slate-800 text-white rounded-lg font-medium text-sm transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 shadow-xs"
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    <span>Procesando...</span>
                  </>
                ) : (
                  <>
                    {activeTab === "photo" ? <UploadCloud className="w-4 h-4 text-amber-400" /> : <Search className="w-4 h-4" />}
                    <span>{activeTab === "photo" ? "Analizar Archivos / Fotos" : "Iniciar Desglose Crítico"}</span>
                  </>
                )}
              </button>

              {error && (
                <div className="mt-4 p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 space-y-2.5 animate-fadeIn">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                    <span className="leading-relaxed">{error}</span>
                  </div>
                  <div className="flex items-center justify-end gap-2 pt-1 border-t border-rose-100">
                    <button
                      onClick={() => setError(null)}
                      className="px-2.5 py-1 text-[11px] text-slate-600 hover:text-slate-900 bg-white border border-slate-200 rounded cursor-pointer transition-colors"
                    >
                      Cerrar
                    </button>
                    <button
                      onClick={() => {
                        setError(null);
                        startAnalysis();
                      }}
                      className="px-3 py-1 text-[11px] font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded shadow-2xs cursor-pointer transition-colors flex items-center gap-1"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Reintentar ahora
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* History Panel */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
              <div className="flex items-center justify-between gap-2 mb-2">
                <h2 className="text-base font-display font-semibold text-slate-900 flex items-center gap-2">
                  <Layers className="w-5 h-5 text-slate-700" />
                  Histórico de Análisis
                </h2>
                {analyses.length > 0 && (
                  <button
                    onClick={() => setShowClearAllModal(true)}
                    className="text-[11px] text-slate-400 hover:text-rose-600 font-mono transition-colors cursor-pointer px-2 py-0.5 rounded hover:bg-rose-50"
                    title="Vaciar todo el historial"
                  >
                    Vaciar todo
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-500 mb-3.5">Selecciona cualquier recurso analizado para desplegar sus resultados académicos.</p>

              <div className="space-y-2.5 max-h-[380px] overflow-y-auto pr-1">
                {analyses.length === 0 ? (
                  <div className="py-6 text-center border-2 border-dashed border-slate-100 rounded-lg text-slate-400">
                    <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <span className="text-xs">No hay análisis registrados todavía</span>
                  </div>
                ) : (
                  analyses.map((item) => {
                    const scoredSrc = (item.bibliographicSources || []).filter((x) => typeof x.reliabilityScore === "number") as Array<BibliographicSource & { reliabilityScore: number }>;
                    const itemScore: number | null = typeof item.overallReliabilityScore === "number" ? item.overallReliabilityScore : (scoredSrc.length ? Math.round(scoredSrc.reduce((acc, x) => acc + x.reliabilityScore, 0) / scoredSrc.length) : null);
                    return (
                    <div
                      key={item.id}
                      onClick={() => setSelectedAnalysis(item)}
                      className={`p-3 rounded-lg border transition-all cursor-pointer flex flex-col gap-2 ${
                        selectedAnalysis?.id === item.id
                          ? "border-slate-900 bg-slate-50 shadow-xs ring-1 ring-slate-900/10"
                          : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/60"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <div className="mt-0.5 shrink-0">
                            {getContentTypeIcon(item.contentType)}
                          </div>
                          <div className="min-w-0">
                            <h4 className="text-xs font-semibold text-slate-800 leading-snug line-clamp-2">
                              {item.title}
                            </h4>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[10px] font-mono text-slate-400">
                                {new Date(item.analyzedAt).toLocaleDateString("es-ES")}
                              </span>
                              <span className="text-[10px] font-mono text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.2 rounded-full font-medium">
                                {item.originalLanguage.toUpperCase()}
                              </span>
                              {itemScore !== null && (
                                <span className="text-[10px] font-mono text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded-full font-medium" title="Media de la fiabilidad de las fuentes verificadas">
                                  Fuentes: {itemScore}/100
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Card Action Toolbar */}
                      <div className="flex items-center justify-between border-t border-slate-100 pt-2 mt-0.5" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={() => handleCopyNotion(item)}
                            className="text-[11px] text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded transition-colors flex items-center gap-1 font-medium cursor-pointer border border-transparent hover:border-indigo-100"
                            title="Copiar para Notion"
                          >
                            <Copy className="w-3 h-3 text-indigo-500" />
                            Notion
                          </button>
                          <button
                            onClick={() => handleDownloadMarkdown(item)}
                            className="text-[11px] text-slate-600 hover:text-emerald-600 hover:bg-emerald-50 px-2 py-1 rounded transition-colors flex items-center gap-1 font-medium cursor-pointer border border-transparent hover:border-emerald-100"
                            title="Descargar archivo Markdown"
                          >
                            <Download className="w-3 h-3 text-emerald-500" />
                            .md
                          </button>
                        </div>

                        <button
                          onClick={(e) => requestDeleteAnalysis(item.id, item.title, e)}
                          className="text-[11px] text-slate-400 hover:text-rose-600 hover:bg-rose-50 px-2 py-1 rounded transition-colors flex items-center gap-1 cursor-pointer"
                          title="Eliminar este análisis"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>Eliminar</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
              </div>
            </div>

            {/* Credibility Legend Info */}
            <div className="bg-slate-900 text-slate-300 border border-slate-800 rounded-xl p-4 shadow-sm text-xs space-y-2">
              <h4 className="font-display font-semibold text-white flex items-center gap-1.5">
                <Award className="w-4 h-4 text-amber-400" />
                Criterios de Rigor Académico
              </h4>
              <p className="text-[11px] leading-relaxed text-slate-400">
                Lupa Crítica califica cada fuente de debate basándose en:
              </p>
              <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-400 font-mono">
                <li><strong className="text-slate-300">80-100:</strong> Revisión por pares, rigor científico.</li>
                <li><strong className="text-slate-300">60-79:</strong> Ensayos serios, periodismo riguroso.</li>
                <li><strong className="text-slate-300">0-59:</strong> Opiniones, material sin contrastar.</li>
              </ul>
            </div>

          </div>

          {/* Right Column (Active Report visualization): 8/12 width */}
          <div className="lg:col-span-8">
            
            <AnimatePresence mode="wait">
              {loading ? (
                <motion.div
                  initial={{ opacity: 0, y: 15 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -15 }}
                  className="bg-white border border-slate-200 rounded-xl p-12 text-center shadow-xs flex flex-col items-center justify-center min-h-[500px]"
                >
                  <div className="relative mb-6">
                    <div className="w-16 h-16 rounded-full border-4 border-slate-100 border-t-slate-900 animate-spin"></div>
                    <ShieldCheck className="w-6 h-6 text-slate-900 absolute top-5 left-5 animate-pulse" />
                  </div>
                  
                  <h3 className="text-lg font-display font-semibold text-slate-900 mb-2">Construyendo Gabinete Crítico</h3>
                  <p className="text-sm text-slate-500 max-w-md mx-auto leading-relaxed h-12">
                    {loadingStep}
                  </p>
                  
                  <div className="w-full max-w-xs bg-slate-100 h-1 rounded-full overflow-hidden mt-6">
                    <div className="h-full bg-slate-900 animate-loadingProgress rounded-full"></div>
                  </div>
                  
                  <p className="text-xs text-slate-400 mt-4 italic">"La duda metódica es la antesala de la veracidad científica"</p>
                </motion.div>
              ) : selectedAnalysis ? (
                <motion.div
                  key={selectedAnalysis.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
                >
                  {/* Report Main Header Card */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
                    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4 mb-4">
                      <div className="flex items-center gap-2">
                        {getContentTypeIcon(selectedAnalysis.contentType)}
                        <span className="text-xs font-mono font-medium text-slate-500 uppercase tracking-wider">
                          {selectedAnalysis.contentType === "photo" ? "Análisis de Fotografía / Prensa" : `Análisis de ${selectedAnalysis.contentType}`}
                        </span>
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Auto Fact-Check and Contrast Report with Web Search */}
                        <button
                          onClick={handleAutoFactCheck}
                          disabled={isAuditing}
                          className="text-xs px-3.5 py-1.5 rounded-lg flex items-center gap-2 transition-all font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-xs cursor-pointer disabled:opacity-50"
                          title="A propia app consulta as fontes oficiais máis fiables en tempo real, contrasta cada dato e xera un informe completo sen que teñas que buscalas ti"
                        >
                          {isAuditing ? (
                            <>
                              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                              <span>Contrastando con fontes oficiais...</span>
                            </>
                          ) : (
                            <>
                              <Search className="w-3.5 h-3.5 text-emerald-200" />
                              <span>Auditar e Contrastar coa Web</span>
                            </>
                          )}
                        </button>

                        {/* Optional manual nuance / observation */}
                        <button
                          onClick={() => {
                            setUserCorrectionText("");
                            setShowCorrectionModal(true);
                          }}
                          className="text-xs px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 transition-all font-medium text-slate-600 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 border border-slate-200 shadow-2xs cursor-pointer"
                          title="Se o desexas, tamén podes achegar un matiz ou dato puntual"
                        >
                          <Edit3 className="w-3 h-3 text-slate-500" />
                          <span>Matiz manual</span>
                        </button>

                        {/* Direct In-place Editing Mode */}
                        <button
                          onClick={() => {
                            if (isDirectEditMode) {
                              handleSaveDirectEdit();
                            } else {
                              setIsDirectEditMode(true);
                            }
                          }}
                          disabled={isSavingManualEdit}
                          className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all font-medium border shadow-xs cursor-pointer ${
                            isDirectEditMode
                              ? "bg-indigo-600 text-white border-indigo-700 hover:bg-indigo-700"
                              : "bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                          }`}
                          title={isDirectEditMode ? "Gardar cambios realizados manualmente" : "Editar directamente os textos deste informe"}
                        >
                          {isSavingManualEdit ? (
                            <>
                              <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                              <span>Gardando...</span>
                            </>
                          ) : isDirectEditMode ? (
                            <>
                              <Save className="w-3.5 h-3.5 text-white" />
                              <span>Gardar Edición</span>
                            </>
                          ) : (
                            <>
                              <Edit3 className="w-3.5 h-3.5 text-slate-500" />
                              <span>Modo Edición</span>
                            </>
                          )}
                        </button>

                        {/* Language switcher pills */}
                        <div className="flex items-center gap-0.5 bg-slate-100 p-0.5 rounded-lg border border-slate-200">
                          <Languages className="w-3.5 h-3.5 text-slate-500 ml-1.5 mr-0.5" />
                          <button
                            onClick={() => handleSwitchLanguage("galego")}
                            disabled={isSwitchingLanguage}
                            className={`px-2 py-0.5 text-[11px] font-medium rounded transition-all cursor-pointer ${
                              selectedAnalysis.outputLanguage === "galego"
                                ? "bg-white text-indigo-700 font-bold shadow-2xs"
                                : "text-slate-600 hover:text-slate-900"
                            }`}
                            title="Traducir / Ver informe en Galego"
                          >
                            Galego
                          </button>
                          <button
                            onClick={() => handleSwitchLanguage("castellano")}
                            disabled={isSwitchingLanguage}
                            className={`px-2 py-0.5 text-[11px] font-medium rounded transition-all cursor-pointer ${
                              selectedAnalysis.outputLanguage === "castellano" || !selectedAnalysis.outputLanguage
                                ? "bg-white text-indigo-700 font-bold shadow-2xs"
                                : "text-slate-600 hover:text-slate-900"
                            }`}
                            title="Traducir / Ver informe en Castellano"
                          >
                            Castellano
                          </button>
                          <button
                            onClick={() => handleSwitchLanguage("català")}
                            disabled={isSwitchingLanguage}
                            className={`px-2 py-0.5 text-[11px] font-medium rounded transition-all cursor-pointer ${
                              selectedAnalysis.outputLanguage === "català"
                                ? "bg-white text-indigo-700 font-bold shadow-2xs"
                                : "text-slate-600 hover:text-slate-900"
                            }`}
                            title="Traducir / Ver informe en Català"
                          >
                            Català
                          </button>
                        </div>

                        <div className="h-4 w-px bg-slate-200 mx-0.5"></div>

                        <button
                          onClick={() => handleCopyNotion()}
                          className={`text-xs px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all font-medium border shadow-xs cursor-pointer ${
                            copiedNotion
                              ? "bg-emerald-600 text-white border-emerald-700 shadow-sm"
                              : "bg-white text-slate-800 border-slate-300 hover:bg-slate-50 hover:border-slate-400 hover:text-slate-900"
                          }`}
                          title="Copiar contenido en formato Markdown estructurado para Notion"
                        >
                          {copiedNotion ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-white shrink-0" />
                              <span className="font-semibold text-white">¡Copiado!</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5 text-indigo-600 shrink-0" />
                              <span className="font-semibold text-slate-800">Notion</span>
                            </>
                          )}
                        </button>

                        <button
                          onClick={() => handleDownloadMarkdown()}
                          className="text-xs text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 hover:border-slate-400 hover:text-slate-900 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all font-medium shadow-xs cursor-pointer"
                          title="Descargar análisis completo como archivo Markdown (.md) para importar a Notion"
                        >
                          <Download className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span className="font-semibold text-slate-800">.md</span>
                        </button>

                        {selectedAnalysis.url && (
                          <a
                            href={selectedAnalysis.url}
                            target="_blank"
                            referrerPolicy="no-referrer"
                            rel="noreferrer"
                            className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 px-2.5 py-1.5 rounded-lg flex items-center gap-1 transition-all font-medium"
                          >
                            <ExternalLink className="w-3 h-3 text-indigo-600" />
                            Original
                          </a>
                        )}

                        <button
                          onClick={() => requestDeleteAnalysis(selectedAnalysis.id, selectedAnalysis.title)}
                          className="text-xs text-slate-400 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-200 px-2 py-1.5 rounded-lg flex items-center gap-1 transition-all cursor-pointer"
                          title="Eliminar este análisis"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <h2 className="text-2xl font-display font-bold text-slate-900 tracking-tight leading-tight">
                      {selectedAnalysis.title}
                    </h2>

                    {selectedAnalysis.fileNames && selectedAnalysis.fileNames.length > 0 && (
                      <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                            <FileText className="w-3.5 h-3.5 text-amber-600" />
                            Documentos / Informes analizados
                          </span>
                          <span className="text-[11px] text-slate-500 font-mono">{selectedAnalysis.fileNames.length} archivo(s)</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {selectedAnalysis.fileNames.map((fname, fidx) => {
                            const isPdf = fname.toLowerCase().endsWith(".pdf");
                            const isWord = fname.toLowerCase().endsWith(".doc") || fname.toLowerCase().endsWith(".docx");
                            return (
                              <div key={fidx} className="flex items-center gap-1.5 px-2.5 py-1 bg-white border border-slate-200 rounded-md shadow-2xs text-xs">
                                {isPdf ? (
                                  <span className="px-1.5 py-0.5 text-[10px] font-bold bg-rose-100 text-rose-700 rounded font-mono">PDF</span>
                                ) : isWord ? (
                                  <span className="px-1.5 py-0.5 text-[10px] font-bold bg-blue-100 text-blue-700 rounded font-mono">WORD</span>
                                ) : (
                                  <span className="px-1.5 py-0.5 text-[10px] font-bold bg-slate-100 text-slate-700 rounded font-mono">FILE</span>
                                )}
                                <span className="font-medium text-slate-800 truncate max-w-[220px]">{fname}</span>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {selectedAnalysis.photoUrls && selectedAnalysis.photoUrls.length > 0 && (
                      <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
                            <Camera className="w-3.5 h-3.5 text-emerald-600" />
                            Fotografía(s) del artículo analizadas
                          </span>
                          <span className="text-[11px] text-slate-500 font-mono">{selectedAnalysis.photoUrls.length} imagen(es)</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {selectedAnalysis.photoUrls.map((imgUrl, imgIdx) => (
                            <div 
                              key={imgIdx} 
                              className="relative group cursor-pointer border border-slate-300 rounded-lg overflow-hidden bg-white shadow-xs" 
                              onClick={() => setViewingPhoto(imgUrl)}
                              title="Haz clic para ver la fotografía a tamaño completo"
                            >
                              <img src={imgUrl} alt="Foto analizada" className="h-20 w-auto object-cover group-hover:scale-105 transition-all" />
                              <div className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center text-white text-xs font-medium gap-1">
                                <Eye className="w-3.5 h-3.5" />
                                Ver
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-3 mt-4">
                      {selectedAnalysis.categories.map((cat, idx) => (
                        <span key={idx} className="text-xs font-medium text-slate-700 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-md">
                          {cat}
                        </span>
                      ))}

                      <div className="h-4 w-px bg-slate-200 mx-1"></div>

                      <div className="flex items-center gap-1.5 text-xs text-slate-500">
                        <Globe className="w-3.5 h-3.5 text-slate-400" />
                        Idioma original: <span className="font-semibold text-slate-700">{selectedAnalysis.originalLanguage}</span>
                      </div>

                      {selectedAnalysis.outputLanguage && (
                        <span className="text-[10px] font-mono font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full">
                          Informe en: {selectedAnalysis.outputLanguage.toUpperCase()}
                        </span>
                      )}

                      {!selectedAnalysis.isSpanishOrGalician && (
                        <span className="text-[10px] font-mono font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                          Requiere Traducción
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Live Fact-Check & Verification Audit Card: Informe de Contraste de Datos */}
                  {selectedAnalysis.factCheckAudit ? (
                    <div className={`rounded-xl p-5 sm:p-6 shadow-sm border relative overflow-hidden transition-all ${
                      selectedAnalysis.factCheckAudit.status === "corrected"
                        ? "bg-gradient-to-br from-emerald-50/95 via-teal-50/80 to-emerald-50/95 border-emerald-300 text-slate-800"
                        : "bg-gradient-to-br from-blue-50/95 via-indigo-50/80 to-blue-50/95 border-blue-200 text-slate-800"
                    }`}>
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3.5 border-b border-emerald-200/70">
                        <div className="flex items-start sm:items-center gap-3">
                          <div className="p-2 rounded-lg bg-emerald-600 text-white shadow-2xs shrink-0">
                            <ShieldCheck className="w-5 h-5" />
                          </div>
                          <div>
                            <h4 className="font-display font-bold text-base text-slate-900 flex flex-wrap items-center gap-2">
                              <span>{selectedAnalysis.factCheckAudit.verdictTitle || "Informe de Contraste e Verificación de Datos"}</span>
                              <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                                {selectedAnalysis.factCheckAudit.method === "claim_level_v2" && selectedAnalysis.factCheckAudit.counts
                                  ? `${selectedAnalysis.factCheckAudit.counts.supported} respaldadas · ${selectedAnalysis.factCheckAudit.counts.contradicted + selectedAnalysis.factCheckAudit.counts.partially_supported} con errores · ${Math.max(0, selectedAnalysis.factCheckAudit.counts.insufficient_evidence - (selectedAnalysis.factCheckAudit.coverage?.searchFailed || 0))} sin evidencia suficiente${(selectedAnalysis.factCheckAudit.coverage?.searchFailed || 0) > 0 ? ` · ${selectedAnalysis.factCheckAudit.coverage?.searchFailed} búsquedas fallidas` : ""}`
                                  : "Auditoría anterior (sin detalle por afirmación)"}
                              </span>
                            </h4>
                            <span className="text-[11px] text-slate-500 font-mono">
                              Auditado o {new Date(selectedAnalysis.factCheckAudit.auditedAt).toLocaleString("es-ES")} • Fontes consultadas automaticamente pola app
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={handleAutoFactCheck}
                            disabled={isAuditing}
                            className="text-xs px-3 py-1.5 rounded-lg font-semibold text-emerald-800 bg-white border border-emerald-300 hover:bg-emerald-50 transition-colors shadow-2xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                            title="Volver a consultar e contrastar coas fontes oficiais en tempo real"
                          >
                            <RotateCcw className={`w-3.5 h-3.5 text-emerald-600 ${isAuditing ? "animate-spin" : ""}`} />
                            <span>{isAuditing ? "Contrastando..." : "Actualizar Contraste"}</span>
                          </button>
                        </div>
                      </div>

                      {/* Analytical Summary of Contrast */}
                      <div className="mb-4 bg-white/70 p-3.5 rounded-lg border border-emerald-200/60">
                        <span className="text-[11px] font-mono font-bold text-emerald-900 uppercase tracking-wider block mb-1">
                          Dictame de Verificación e Contraste:
                        </span>
                        <p className="text-xs sm:text-[13px] leading-relaxed text-slate-700 font-medium whitespace-pre-line">
                          {selectedAnalysis.factCheckAudit.summaryAudit}
                        </p>
                      </div>

                      {/* Auditoría v2: afirmaciones comprobadas una a una */}
                      {selectedAnalysis.factCheckAudit.claimChecks && selectedAnalysis.factCheckAudit.claimChecks.length > 0 && (
                        <div className="mb-4 bg-white rounded-xl border border-slate-200 overflow-hidden shadow-2xs">
                          <div className="bg-slate-100/80 px-4 py-2.5 border-b border-slate-200 flex items-center justify-between">
                            <span className="text-xs font-bold font-display text-slate-900 flex items-center gap-1.5">
                              <Scale className="w-4 h-4 text-slate-600" />
                              Afirmaciones auditadas una a una
                            </span>
                            <span className="text-[10.5px] font-mono font-semibold text-slate-700 bg-slate-200/70 px-2 py-0.5 rounded">
                              {selectedAnalysis.factCheckAudit.claimChecks.length} afirmaciones
                            </span>
                          </div>
                          <div className="divide-y divide-slate-100 text-xs">
                            {selectedAnalysis.factCheckAudit.claimChecks.map((c) => (
                              <div key={c.id} className="p-3.5 space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full font-mono border ${c.searchFailed ? "bg-orange-100 text-orange-900 border-orange-300" : CLAIM_VERDICT_UI[c.verdict].chip}`}>
                                    {c.searchFailed ? "Búsqueda fallida (error técnico)" : CLAIM_VERDICT_UI[c.verdict].label}
                                  </span>
                                  {c.verdict !== "not_checkable" && !c.searchFailed && (
                                    <span className="text-[10.5px] font-mono text-slate-500">confianza {c.confidence.toFixed(2)}</span>
                                  )}
                                </div>
                                <p className="text-slate-800 font-semibold leading-snug">{c.claim}</p>
                                {c.quoteLocated && c.quote && (
                                  <p className="text-[11.5px] text-slate-500 italic leading-snug">«{c.quote}»</p>
                                )}
                                <p className="text-slate-700 leading-snug">{c.explanation}</p>
                                {c.correction && (
                                  <div className="p-2.5 bg-rose-50/70 border border-rose-200 rounded-lg">
                                    <span className="text-[10px] font-bold text-rose-800 uppercase block mb-1">Dato según las fuentes:</span>
                                    <p className="text-slate-800 font-semibold leading-snug">{c.correction}</p>
                                  </div>
                                )}
                                {c.evidenceQuote && (
                                  <p className="text-[11.5px] text-slate-500 leading-snug">Evidencia: «{c.evidenceQuote}»</p>
                                )}
                                {c.evidence.length > 0 && (
                                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                                    {c.evidence
                                      .filter((src) => /^https?:\/\//.test(src.url))
                                      .map((src, i) => (
                                        <a key={i} href={src.url} target="_blank" rel="noreferrer" className="text-emerald-700 hover:text-emerald-900 underline flex items-center gap-1">
                                          <span>{src.title || "Fuente"}</span>
                                          <ExternalLink className="w-2.5 h-2.5" />
                                        </a>
                                      ))}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Interactive Contrast Matrix / Cadro Comparativo */}
                      {selectedAnalysis.factCheckAudit.contrastTable && selectedAnalysis.factCheckAudit.contrastTable.length > 0 && (
                        <div className="mb-4 bg-white rounded-xl border border-emerald-200 overflow-hidden shadow-2xs">
                          <div className="bg-emerald-100/70 px-4 py-2.5 border-b border-emerald-200 flex items-center justify-between">
                            <span className="text-xs font-bold font-display text-emerald-950 flex items-center gap-1.5">
                              <Scale className="w-4 h-4 text-emerald-700" />
                              Cadro Comparativo de Contraste: Dato Analizado vs. Fonte Oficial Fiable
                            </span>
                            <span className="text-[10.5px] font-mono font-semibold text-emerald-800 bg-emerald-200/60 px-2 py-0.5 rounded">
                              {selectedAnalysis.factCheckAudit.contrastTable.length} datos contrastados
                            </span>
                          </div>
                          <div className="divide-y divide-emerald-100/80 text-xs">
                            {selectedAnalysis.factCheckAudit.contrastTable.map((item, cidx) => (
                              <div key={cidx} className="p-3.5 hover:bg-emerald-50/40 transition-colors space-y-2.5">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider font-mono">
                                    Comprobación #{cidx + 1}
                                  </span>
                                  <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full font-mono flex items-center gap-1 ${
                                    item.status === "corrected"
                                      ? "bg-amber-100 text-amber-900 border border-amber-300"
                                      : "bg-emerald-100 text-emerald-900 border border-emerald-300"
                                  }`}>
                                    {item.status === "corrected" ? "⚠️ Rectificado con fontes oficiais" : "✓ Dato Exacto e Verificado"}
                                  </span>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div className="p-2.5 bg-rose-50/70 border border-rose-150 rounded-lg">
                                    <span className="text-[10px] font-bold text-rose-800 uppercase block mb-1">
                                      Dato / Afirmación no texto inicial:
                                    </span>
                                    <p className="text-slate-700 leading-snug font-sans">{item.claimOrFact}</p>
                                  </div>
                                  <div className="p-2.5 bg-emerald-50/80 border border-emerald-200 rounded-lg">
                                    <span className="text-[10px] font-bold text-emerald-800 uppercase block mb-1">
                                      Dato contrastado na fonte fiable:
                                    </span>
                                    <p className="text-slate-800 font-semibold leading-snug font-sans">{item.officialVerification}</p>
                                  </div>
                                </div>

                                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-slate-500">
                                  <div className="flex items-center gap-1.5 font-medium text-emerald-900">
                                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                                    <span>Organismo / Fonte oficial fiable: <strong>{item.reliableSource}</strong></span>
                                  </div>
                                  {item.sourceUrl && (
                                    <a
                                      href={item.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="text-emerald-700 hover:text-emerald-900 underline flex items-center gap-1"
                                    >
                                      <span>Consultar fonte orixinal</span>
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Inaccuracies Detected and Corrected */}
                      {selectedAnalysis.factCheckAudit.detectedErrors && selectedAnalysis.factCheckAudit.detectedErrors.length > 0 && (
                        <div className="mb-3.5 p-3.5 bg-white/90 rounded-lg border border-emerald-200/80 text-xs space-y-1.5">
                          <span className="font-semibold text-rose-800 text-[11px] uppercase tracking-wider block">
                            Inexactitudes detectadas e rectificadas no informe:
                          </span>
                          <ul className="list-disc list-inside space-y-1 text-slate-700 text-[11.5px]">
                            {selectedAnalysis.factCheckAudit.detectedErrors.map((err, eidx) => (
                              <li key={eidx} className="leading-snug">{err}</li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Reliable Sources Found Automatically By The App */}
                      {selectedAnalysis.factCheckAudit.verifiedSources && selectedAnalysis.factCheckAudit.verifiedSources.length > 0 && (
                        <div className="pt-2 border-t border-emerald-200/60">
                          <div className="flex items-center gap-1.5 mb-2 text-xs font-semibold text-slate-700">
                            <ExternalLink className="w-3.5 h-3.5 text-emerald-600" />
                            <span>Fontes oficiais e fiables consultadas automaticamente pola app (sen que teñas que buscalas ti):</span>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            {selectedAnalysis.factCheckAudit.verifiedSources.map((src, sidx) => (
                              <a
                                key={sidx}
                                href={src.url}
                                target="_blank"
                                referrerPolicy="no-referrer"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-emerald-900 bg-white hover:bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-md shadow-2xs transition-colors"
                              >
                                <span>{src.title}</span>
                                <ExternalLink className="w-3 h-3 text-emerald-600 shrink-0" />
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="bg-gradient-to-r from-slate-50 via-emerald-50/30 to-slate-50 border border-emerald-200/80 rounded-xl p-4 sm:p-5 shadow-2xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 text-xs">
                      <div className="flex items-start gap-3 text-slate-700">
                        <div className="p-2 rounded-lg bg-emerald-100 text-emerald-700 shrink-0 mt-0.5">
                          <Search className="w-4 h-4" />
                        </div>
                        <div className="space-y-0.5">
                          <h4 className="font-display font-semibold text-slate-900 text-sm">
                            ¿Queres contrastar todos os datos coas fontes máis fiables?
                          </h4>
                          <p className="text-slate-600 leading-relaxed text-xs">
                            A propia app consulta en tempo real o arquivo oficial, hemerotecas e rexistros de máxima solvencia e xera un <strong>informe detallado de contraste</strong> comparando cada dato sen que teñas que buscalos ti.
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={handleAutoFactCheck}
                        disabled={isAuditing}
                        className="shrink-0 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-semibold text-xs transition-colors shadow-2xs cursor-pointer flex items-center gap-2 disabled:opacity-50"
                      >
                        {isAuditing ? (
                          <>
                            <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                            <span>Contrastando con fontes oficiais...</span>
                          </>
                        ) : (
                          <>
                            <Search className="w-3.5 h-3.5 text-emerald-200" />
                            <span>Auditar e Contrastar agora</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {/* Executive Summary Section */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
                    <div className="flex items-center justify-between gap-2 mb-4">
                      <h3 className="text-lg font-display font-semibold text-slate-900 flex items-center gap-2">
                        <FileCheck className="w-5 h-5 text-slate-700" />
                        Resumen Ejecutivo Automático
                      </h3>
                      {!isDirectEditMode && (
                        <button
                          onClick={() => setIsDirectEditMode(true)}
                          className="text-[11px] text-slate-400 hover:text-indigo-600 flex items-center gap-1 font-medium transition-colors cursor-pointer"
                          title="Editar manualmente este texto"
                        >
                          <Edit3 className="w-3 h-3" />
                          Editar texto
                        </button>
                      )}
                    </div>

                    {isDirectEditMode ? (
                      <div className="space-y-3">
                        <textarea
                          rows={8}
                          value={editableSummary}
                          onChange={(e) => setEditableSummary(e.target.value)}
                          className="w-full p-3 text-sm bg-slate-50 border border-indigo-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:bg-white text-slate-800 leading-relaxed font-sans"
                          placeholder="Escribe o edita el resumen ejecutivo..."
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => {
                              setEditableSummary(selectedAnalysis.executiveSummary);
                              setIsDirectEditMode(false);
                            }}
                            className="px-3 py-1 text-xs text-slate-600 hover:text-slate-900 border border-slate-200 rounded-md cursor-pointer"
                          >
                            Cancelar
                          </button>
                          <button
                            onClick={handleSaveDirectEdit}
                            disabled={isSavingManualEdit}
                            className="px-3.5 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md cursor-pointer flex items-center gap-1 shadow-2xs"
                          >
                            <Save className="w-3.5 h-3.5" />
                            <span>{isSavingManualEdit ? "Guardando..." : "Guardar Resumen"}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="prose prose-slate max-w-none text-slate-700 text-sm leading-relaxed whitespace-pre-line">
                        {selectedAnalysis.executiveSummary}
                      </div>
                    )}
                  </div>

                  {/* Staged Key points list */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
                    <div className="flex items-center justify-between gap-2 mb-4">
                      <h3 className="text-lg font-display font-semibold text-slate-900 flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-indigo-600" />
                        Puntos Clave Extraídos
                      </h3>
                      {isDirectEditMode && (
                        <button
                          onClick={() => setEditableKeyPoints(prev => [...prev, "Nuevo punto clave..."])}
                          className="text-xs text-indigo-600 hover:text-indigo-800 flex items-center gap-1 font-semibold cursor-pointer"
                        >
                          <PlusCircle className="w-3.5 h-3.5" />
                          Engadir punto
                        </button>
                      )}
                    </div>

                    {isDirectEditMode ? (
                      <div className="space-y-3">
                        {editableKeyPoints.map((point, idx) => (
                          <div key={idx} className="flex items-start gap-2 p-2 bg-slate-50 border border-indigo-100 rounded-lg">
                            <span className="w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px] font-mono shrink-0 mt-1">
                              {idx + 1}
                            </span>
                            <textarea
                              rows={2}
                              value={point}
                              onChange={(e) => {
                                const val = e.target.value;
                                setEditableKeyPoints(prev => {
                                  const next = [...prev];
                                  next[idx] = val;
                                  return next;
                                });
                              }}
                              className="w-full p-2 text-xs bg-white border border-slate-200 rounded focus:ring-1 focus:ring-indigo-600 text-slate-800"
                            />
                            <button
                              onClick={() => setEditableKeyPoints(prev => prev.filter((_, i) => i !== idx))}
                              className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                              title="Eliminar este punto"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <div className="flex items-center justify-end gap-2 pt-2">
                          <button
                            onClick={handleSaveDirectEdit}
                            disabled={isSavingManualEdit}
                            className="px-3.5 py-1 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-md cursor-pointer flex items-center gap-1 shadow-2xs"
                          >
                            <Save className="w-3.5 h-3.5" />
                            <span>{isSavingManualEdit ? "Guardando..." : "Guardar Puntos Clave"}</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3.5">
                        {selectedAnalysis.keyPoints.map((point, idx) => (
                          <div key={idx} className="flex items-start gap-3 p-3 bg-slate-50 border border-slate-100 rounded-lg">
                            <span className="w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center text-[10px] font-mono shrink-0 mt-0.5">
                              {idx + 1}
                            </span>
                            <p className="text-sm text-slate-700 leading-relaxed">{point}</p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Resumen Explicativo con Ejemplos Numéricos, Costes y Cifras Reales */}
                  {selectedAnalysis.numericalExamples && selectedAnalysis.numericalExamples.length > 0 && (
                    <div className="bg-emerald-950/95 text-emerald-50 border border-emerald-800 rounded-xl p-6 shadow-md relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none"></div>
                      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-emerald-800/80">
                        <div className="flex items-center gap-2">
                          <Calculator className="w-5 h-5 text-emerald-400" />
                          <h3 className="text-lg font-display font-semibold text-white">
                            Resumen Explicativo con Ejemplos Numéricos, Costes y Cifras Reales
                          </h3>
                        </div>
                        <span className="text-[10px] font-mono font-bold text-emerald-300 bg-emerald-900/80 border border-emerald-700 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                          <Coins className="w-3 h-3 text-emerald-400" /> Cifras y Costes
                        </span>
                      </div>
                      <p className="text-xs text-emerald-200/90 mb-4">
                        Desglose intuitivo de los conceptos complejos del artículo mediante ejemplos cuantitativos tangibles, datos financieros y ratios de coste:
                      </p>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {selectedAnalysis.numericalExamples.map((item, idx) => (
                          <div 
                            key={idx} 
                            className="p-4 sm:p-5 bg-emerald-900/70 border border-emerald-800/90 rounded-xl space-y-3 flex flex-col justify-between overflow-hidden shadow-xs hover:border-emerald-700/80 transition-all"
                          >
                            <div className="space-y-2.5 min-w-0">
                              <div className="flex flex-col gap-2">
                                <span className="text-xs font-semibold text-emerald-200 leading-snug break-words font-display min-w-0">
                                  {item.concept}
                                </span>
                                <div className="self-start max-w-full">
                                  <span className="inline-block text-xs font-mono font-bold text-amber-300 bg-amber-950/90 border border-amber-700/70 px-2.5 py-1 rounded-md shadow-2xs break-words whitespace-normal text-left max-w-full leading-relaxed">
                                    {item.figureOrCost}
                                  </span>
                                </div>
                              </div>
                              <p className="text-xs text-emerald-100/90 leading-relaxed font-sans break-words whitespace-pre-line">
                                {item.explanation}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Evaluación de explorador: antes de criticar, lo que acierta el autor y qué cambiaría la conclusión */}
                  {selectedAnalysis.scoutAssessment && (
                    <div className="bg-white border border-sky-200/80 rounded-xl p-6 shadow-xs">
                      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-sky-100">
                        <h3 className="text-lg font-display font-semibold text-slate-900 flex items-center gap-2">
                          <Scale className="w-5 h-5 text-sky-600" />
                          Lectura de explorador
                        </h3>
                        <span className={`text-[10px] font-mono font-semibold px-2.5 py-0.5 rounded-full border ${
                          selectedAnalysis.scoutAssessment.evidenceSufficiency === "suficiente" ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                          : selectedAnalysis.scoutAssessment.evidenceSufficiency === "parcial" ? "text-amber-700 bg-amber-50 border-amber-200"
                          : "text-rose-700 bg-rose-50 border-rose-200"}`}>
                          Evidencia {selectedAnalysis.scoutAssessment.evidenceSufficiency}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 text-xs text-slate-700 leading-snug">
                        {selectedAnalysis.scoutAssessment.whereAuthorIsRight.length > 0 && (
                          <div>
                            <h4 className="font-semibold text-slate-900 mb-1.5">Dónde acierta el texto</h4>
                            <ul className="list-disc pl-4 space-y-1">{selectedAnalysis.scoutAssessment.whereAuthorIsRight.map((t, i) => <li key={i}>{t}</li>)}</ul>
                          </div>
                        )}
                        {selectedAnalysis.scoutAssessment.strongestVersion && (
                          <div>
                            <h4 className="font-semibold text-slate-900 mb-1.5">La versión más fuerte de su tesis</h4>
                            <p>{selectedAnalysis.scoutAssessment.strongestVersion}</p>
                          </div>
                        )}
                        {selectedAnalysis.scoutAssessment.implicationsIfTrue.length > 0 && (
                          <div>
                            <h4 className="font-semibold text-slate-900 mb-1.5">Si fuera cierto, ¿qué implicaría?</h4>
                            <ul className="list-disc pl-4 space-y-1">{selectedAnalysis.scoutAssessment.implicationsIfTrue.map((t, i) => <li key={i}>{t}</li>)}</ul>
                          </div>
                        )}
                        {selectedAnalysis.scoutAssessment.whatWouldChangeTheConclusion.length > 0 && (
                          <div>
                            <h4 className="font-semibold text-slate-900 mb-1.5">Qué evidencia cambiaría la conclusión</h4>
                            <ul className="list-disc pl-4 space-y-1">{selectedAnalysis.scoutAssessment.whatWouldChangeTheConclusion.map((t, i) => <li key={i}>{t}</li>)}</ul>
                          </div>
                        )}
                      </div>
                      {selectedAnalysis.scoutAssessment.sufficiencyNote && (
                        <p className="mt-3 text-[11.5px] text-slate-500 italic leading-snug">{selectedAnalysis.scoutAssessment.sufficiencyNote}</p>
                      )}
                    </div>
                  )}

                  {/* Scientific & Methodological Critical Positions */}
                  {selectedAnalysis.criticalPositions && selectedAnalysis.criticalPositions.length > 0 && (
                    <div className="bg-white border border-rose-200/80 rounded-xl p-6 shadow-xs relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-32 h-32 bg-rose-500/5 rounded-full blur-2xl pointer-events-none"></div>
                      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-rose-100">
                        <div className="flex items-center gap-2">
                          <ShieldAlert className="w-5 h-5 text-rose-600" />
                          <h3 className="text-lg font-display font-semibold text-slate-900">
                            Posiciones Críticas Científicas y Metodológicas
                          </h3>
                        </div>
                        <span className="text-[10px] font-mono font-semibold text-rose-700 bg-rose-50 border border-rose-200 px-2.5 py-0.5 rounded-full">
                          Contraargumentación Rigurosa
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 mb-5">
                        Objeciones, matices y contraejemplos fundamentados en evidencia empírica o marcos epistemológicos consolidados que cuestionan o delimitan las afirmaciones del recurso:
                      </p>
                      
                      <div className="space-y-4">
                        {selectedAnalysis.criticalPositions.map((crit, idx) => (
                          <div key={idx} className="p-4 bg-rose-50/40 border border-rose-150 rounded-lg space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-mono font-bold text-rose-800 bg-rose-100/80 px-2 py-0.5 rounded">
                                Posición #{idx + 1}
                              </span>
                              <h4 className="font-display font-bold text-sm text-slate-900">
                                {crit.title}
                              </h4>
                            </div>
                            <p className="text-sm text-slate-700 leading-relaxed font-sans">
                              {crit.argument}
                            </p>
                            <div className="pt-2 border-t border-rose-100/60 text-xs text-slate-600 flex items-start gap-1.5">
                              <Scale className="w-3.5 h-3.5 text-rose-600 shrink-0 mt-0.5" />
                              <span>
                                <strong className="text-rose-900 font-semibold">Fundamento Científico/Empírico:</strong> {crit.scientificBasis}
                              </span>
                            </div>

                            {crit.targetClaim && (
                              <p className="text-[11.5px] text-slate-500 italic leading-snug">Se refiere a: «{crit.targetClaim}»</p>
                            )}
                            {crit.critiqueType && (
                              <span className="inline-block text-[10px] font-mono font-semibold text-rose-700 bg-white border border-rose-200 px-2 py-0.5 rounded">
                                {CRITIQUE_TYPE_LABEL[crit.critiqueType] || crit.critiqueType}
                              </span>
                            )}
                            {crit.evidenceThatWouldSettleIt && (
                              <div className="p-2.5 bg-white border border-rose-100 rounded-lg text-xs text-slate-700 leading-snug">
                                <strong className="text-rose-900">Qué evidencia lo resolvería:</strong> {crit.evidenceThatWouldSettleIt}
                                {crit.suggestedSources && crit.suggestedSources.length > 0 && (
                                  <span className="block mt-1 text-slate-500">Dónde consultarla (la app no lo ha consultado): {crit.suggestedSources.join(" · ")}</span>
                                )}
                              </div>
                            )}
                            {crit.studyDiscardedNote && (
                              <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 leading-snug">{crit.studyDiscardedNote}</p>
                            )}

                            {/* Estudio asociado: solo se muestra si existe, coincide y su resumen se ha comprobado frente a esta posición */}
                            {crit.supportingStudy && (
                              <div className="mt-3 p-3 bg-white border border-rose-200/90 rounded-lg text-xs shadow-2xs space-y-2">
                                <div className="flex flex-wrap items-center justify-between gap-2 pb-1.5 border-b border-slate-100">
                                  <div className={`flex items-center gap-1.5 font-medium ${VERIFICATION_UI[crit.supportingStudy.verificationStatus ?? "not_found"].tone}`}>
                                    <ShieldCheck className="w-4 h-4 shrink-0" />
                                    <span className="font-mono text-[11px] font-bold">
                                      {crit.supportingStudy.verificationStatus
                                        ? VERIFICATION_UI[crit.supportingStudy.verificationStatus].label
                                        : "Verificación anterior (no fiable): se hizo sin comprobar que la obra coincida ni que respalde la posición"}
                                    </span>
                                  </div>
                                  {crit.supportingStudy.citationsCount !== undefined && crit.supportingStudy.citationsCount !== null && (
                                    <span className="text-[10px] font-mono text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                                      {crit.supportingStudy.citationsCount} citas registradas
                                    </span>
                                  )}
                                </div>
                                
                                <div>
                                  <h5 className="font-display font-semibold text-slate-900 text-xs leading-snug">
                                    {crit.supportingStudy.title}
                                  </h5>
                                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-500 mt-1">
                                    <span>Autor/es: <strong className="text-slate-700 font-semibold">{crit.supportingStudy.author}</strong></span>
                                    {crit.supportingStudy.year && <span>Año: <strong>{crit.supportingStudy.year}</strong></span>}
                                    {crit.supportingStudy.isRetracted && <span className="font-bold text-rose-700">RETRACTADA</span>}
                                    {crit.supportingStudy.journalOrVenue && <span>Revista: <strong className="italic text-slate-700">{crit.supportingStudy.journalOrVenue}</strong></span>}
                                  </div>
                                </div>

                                {crit.supportingStudy.supportVerdict && (
                                  <p className="text-[11px] text-slate-600 leading-snug">
                                    <strong className="text-slate-800">{SUPPORT_UI[crit.supportingStudy.supportVerdict]}.</strong>
                                    {crit.supportingStudy.supportQuote && <span className="italic"> «{crit.supportingStudy.supportQuote}»</span>}
                                  </p>
                                )}

                                <div className="flex flex-wrap items-center gap-2 pt-1">
                                  {crit.supportingStudy.doi && (
                                    <a
                                      href={crit.supportingStudy.doi}
                                      target="_blank"
                                      referrerPolicy="no-referrer"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2 py-0.5 rounded transition-colors"
                                      title="Enlace DOI oficial al estudio"
                                    >
                                      DOI / Paper Oficial
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  )}
                                  {crit.supportingStudy.openAccessUrl && (
                                    <a
                                      href={crit.supportingStudy.openAccessUrl}
                                      target="_blank"
                                      referrerPolicy="no-referrer"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-[10px] font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 border border-teal-200 px-2 py-0.5 rounded transition-colors"
                                      title="Texto completo Open Access"
                                    >
                                      PDF Abierto
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  )}
                                  {crit.supportingStudy.link && (
                                    <a
                                      href={crit.supportingStudy.link}
                                      target="_blank"
                                      referrerPolicy="no-referrer"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-[10px] font-medium text-slate-600 bg-slate-50 hover:bg-slate-100 border border-slate-200 px-2 py-0.5 rounded transition-colors"
                                    >
                                      Google Scholar
                                      <ExternalLink className="w-2.5 h-2.5" />
                                    </a>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Constructive Ongoing Debates Summary */}
                  {selectedAnalysis.constructiveDebatesSummary && (
                    <div className="bg-slate-900 text-slate-100 border border-slate-800 rounded-xl p-6 shadow-md relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>
                      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-slate-800">
                        <div className="flex items-center gap-2">
                          <MessageSquare className="w-5 h-5 text-indigo-400" />
                          <h3 className="text-lg font-display font-semibold text-white">
                            Resumen de Debates Constructivos en Curso
                          </h3>
                        </div>
                        <span className="text-[10px] font-mono font-medium text-indigo-300 bg-indigo-950/80 border border-indigo-700/60 px-2.5 py-0.5 rounded-full">
                          Diálogo Intelectual
                        </span>
                      </div>

                      <div className="space-y-4">
                        <div className="p-4 bg-slate-800/60 border border-slate-700/60 rounded-lg">
                          <h4 className="text-xs font-mono uppercase tracking-wider text-indigo-300 font-semibold mb-1">
                            Estado General de la Discusión
                          </h4>
                          <p className="text-sm leading-relaxed text-slate-200">
                            {selectedAnalysis.constructiveDebatesSummary.overview}
                          </p>
                        </div>

                        {selectedAnalysis.constructiveDebatesSummary.consensusAndDisagreements && (
                          <div className="p-4 bg-indigo-950/40 border border-indigo-900/60 rounded-lg">
                            <h4 className="text-xs font-mono uppercase tracking-wider text-indigo-300 font-semibold mb-1">
                              Consensos y Puntos de Desacuerdo Lógico
                            </h4>
                            <p className="text-sm leading-relaxed text-slate-200">
                              {selectedAnalysis.constructiveDebatesSummary.consensusAndDisagreements}
                            </p>
                          </div>
                        )}

                        {selectedAnalysis.constructiveDebatesSummary.keyQuestions && selectedAnalysis.constructiveDebatesSummary.keyQuestions.length > 0 && (
                          <div className="p-4 bg-slate-800/40 border border-slate-700/50 rounded-lg">
                            <h4 className="text-xs font-mono uppercase tracking-wider text-indigo-300 font-semibold mb-2 flex items-center gap-1.5">
                              <HelpCircle className="w-3.5 h-3.5 text-indigo-400" />
                              Preguntas Abiertas y Dilemas Clave
                            </h4>
                            <ul className="space-y-2">
                              {selectedAnalysis.constructiveDebatesSummary.keyQuestions.map((q, idx) => (
                                <li key={idx} className="flex items-start gap-2 text-xs text-slate-300 leading-relaxed">
                                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 shrink-0 mt-1.5"></span>
                                  <span>{q}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Academic & Intellectual Debates Section */}
                  {selectedAnalysis.academicDebates && (
                    <div className="bg-indigo-950 text-indigo-100 border border-indigo-800 rounded-xl p-6 shadow-md relative overflow-hidden">
                      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>
                      <div className="flex items-center gap-2 mb-3">
                        <Layers className="w-5 h-5 text-indigo-400" />
                        <h3 className="text-lg font-display font-semibold text-white">Debates Académicos e Intelectuales Vigentes</h3>
                        <span className="text-[10px] font-mono font-medium text-indigo-300 bg-indigo-900/80 border border-indigo-700 px-2.5 py-0.5 rounded-full">
                          Análisis Riguroso
                        </span>
                      </div>
                      <p className="text-xs text-indigo-300 mb-4">
                        A continuación se presenta una deconstrucción profunda del debate científico y filosófico en el que se enmarca este recurso, identificando escuelas enfrentadas, hipótesis rivales y cuestiones abiertas:
                      </p>
                      <div className="p-5 bg-indigo-900/50 border border-indigo-800 rounded-lg text-sm leading-relaxed text-indigo-100 font-sans whitespace-pre-line">
                        {selectedAnalysis.academicDebates}
                      </div>
                    </div>
                  )}

                  {/* Glossary of Complex Concepts for University Students */}
                  {selectedAnalysis.glossary && selectedAnalysis.glossary.length > 0 && (
                    <div className="bg-gradient-to-br from-amber-50/80 via-orange-50/40 to-amber-50/80 border border-amber-200/80 rounded-xl p-6 shadow-xs relative overflow-hidden">
                      <div className="flex items-center justify-between gap-2 mb-4 pb-3 border-b border-amber-200/80">
                        <div className="flex items-center gap-2">
                          <GraduationCap className="w-5 h-5 text-amber-700" />
                          <h3 className="text-lg font-display font-semibold text-slate-900">
                            Glosario Didáctico de Conceptos Complejos
                          </h3>
                        </div>
                        <span className="text-[10px] font-mono font-bold text-amber-800 bg-amber-100 border border-amber-300 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                          Casos Reales & Evidencia Contrastada
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 mb-5">
                        Definiciones rigurosas explicadas mediante precedentes históricos documentados, casos reales contrastados y respaldo en evidencias empíricas comprobables:
                      </p>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {selectedAnalysis.glossary.map((item, idx) => (
                          <div key={idx} className="p-4 bg-white/95 border border-amber-200/80 rounded-xl shadow-xs flex flex-col justify-between space-y-4 hover:border-amber-300 hover:shadow-sm transition-all">
                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-2 border-b border-amber-100/80 pb-2">
                                <div className="flex items-center gap-2">
                                  <span className="text-[10px] font-mono font-bold text-amber-900 bg-amber-100/90 px-2 py-0.5 rounded">
                                    Concepto #{idx + 1}
                                  </span>
                                  <h4 className="font-display font-bold text-sm text-slate-900">
                                    {item.term}
                                  </h4>
                                </div>
                              </div>

                              <div className="text-xs text-slate-700 leading-relaxed font-sans bg-slate-50/70 p-2.5 rounded-lg border border-slate-100">
                                <p className="font-medium text-slate-800">{item.definition}</p>
                              </div>

                              {/* Elaborated Case / Practical and Historical Precedent */}
                              {item.simpleExample && (
                                <div className="p-3 bg-amber-50/90 border border-amber-200/80 rounded-lg text-xs space-y-1.5">
                                  <div className="flex items-center gap-1.5 text-amber-950 font-semibold text-[11px]">
                                    <History className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                                    <span>Ejemplo Práctico & Precedente Histórico Real</span>
                                  </div>
                                  <p className="text-slate-700 leading-relaxed text-[11.5px] font-normal">
                                    {item.simpleExample}
                                  </p>
                                </div>
                              )}

                              {/* Scientific Evidence and Proven Foundation */}
                              {item.scientificEvidenceOrSource && (
                                <div className="p-3 bg-emerald-50/80 border border-emerald-200/70 rounded-lg text-xs space-y-1.5">
                                  <div className="flex items-center gap-1.5 text-emerald-950 font-semibold text-[11px]">
                                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                                    <span>Evidencia Científica & Fuente Comprobable</span>
                                  </div>
                                  <p className="text-slate-700 leading-relaxed text-[11.5px] font-normal">
                                    {item.scientificEvidenceOrSource}
                                  </p>
                                </div>
                              )}
                            </div>

                            {item.referenceUrl && (
                              <div className="pt-2 border-t border-amber-100/90 flex justify-end">
                                <a
                                  href={item.referenceUrl}
                                  target="_blank"
                                  referrerPolicy="no-referrer"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-900 bg-amber-50 hover:bg-amber-100 border border-amber-200/90 px-2.5 py-1 rounded-md transition-colors shadow-2xs"
                                  title={`Consultar fuente educativa para ${item.term}`}
                                >
                                  <span>Consultar en Repositorio Oficial</span>
                                  <ExternalLink className="w-3 h-3 text-amber-700" />
                                </a>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Translation display (Full unabridged version or translation generator) */}
                  {selectedAnalysis.translation ? (
                    <div className="bg-slate-50 border border-amber-200 rounded-xl p-6 shadow-xs relative overflow-hidden">
                      <div className="absolute right-0 top-0 w-28 h-28 bg-amber-500/5 rounded-full blur-xl pointer-events-none"></div>
                      
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 pb-3 border-b border-amber-200/80">
                        <div>
                          <div className="flex items-center gap-2">
                            <Globe className="w-5 h-5 text-amber-600" />
                            <h3 className="text-lg font-display font-semibold text-slate-900">
                              Transcripción y Traducción Exhaustiva e Íntegra al Castellano
                            </h3>
                          </div>
                          <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-slate-500">
                            <span>Idioma original: <strong className="text-slate-700">{selectedAnalysis.originalLanguage}</strong></span>
                            <span className="text-slate-300">•</span>
                            <span className="text-[10px] font-mono font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full">
                              100% Íntegra Sin Omisiones
                            </span>
                            <span className="text-slate-300">•</span>
                            <span className="text-[11px] font-mono text-slate-500">
                              ~{selectedAnalysis.translation.split(/\s+/).filter(Boolean).length} palabras
                            </span>
                          </div>
                        </div>

                        {/* Action buttons for translation */}
                        <div className="flex items-center gap-2 self-start sm:self-center shrink-0">
                          <button
                            type="button"
                            onClick={() => handleCopyTranslation(selectedAnalysis.translation || "")}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 transition-colors shadow-2xs"
                            title="Copiar traducción íntegra al portapapeles"
                          >
                            {translationCopied ? (
                              <>
                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                                <span className="text-emerald-700">¡Copiado!</span>
                              </>
                            ) : (
                              <>
                                <Copy className="w-3.5 h-3.5 text-slate-500" />
                                <span>Copiar</span>
                              </>
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={() => handleDownloadTranslation(selectedAnalysis.title, selectedAnalysis.translation || "")}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 border border-slate-200 rounded-lg text-xs font-semibold text-slate-700 transition-colors shadow-2xs"
                            title="Descargar traducción completa en archivo de texto .txt"
                          >
                            <Download className="w-3.5 h-3.5 text-slate-500" />
                            <span>Descargar TXT</span>
                          </button>

                          <button
                            type="button"
                            disabled={isTranslatingFull}
                            onClick={() => handleRequestFullTranslation(selectedAnalysis)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg text-xs font-semibold text-amber-900 transition-colors shadow-2xs disabled:opacity-50"
                            title="Volver a generar o ampliar la traducción íntegra"
                          >
                            <RotateCcw className={`w-3.5 h-3.5 text-amber-700 ${isTranslatingFull ? "animate-spin" : ""}`} />
                            <span>{isTranslatingFull ? "Traduciendo..." : "Regenerar"}</span>
                          </button>
                        </div>
                      </div>

                      <p className="text-xs text-slate-600 mb-4 leading-relaxed">
                        A continuación se presenta la traducción exhaustiva y completa de todo el material analizado de principio a fin, conservando todos los párrafos, explicaciones técnicas, declaraciones y matices originales:
                      </p>

                      <div className="p-6 bg-white border border-slate-200 rounded-xl text-sm leading-relaxed text-slate-800 font-sans max-h-[700px] overflow-y-auto whitespace-pre-line shadow-inner select-text">
                        {selectedAnalysis.translation}
                      </div>
                    </div>
                  ) : !selectedAnalysis.isSpanishOrGalician ? (
                    <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-6 shadow-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Globe className="w-5 h-5 text-amber-700" />
                          <h3 className="text-base font-display font-semibold text-slate-900">
                            Traducción y Transcripción Íntegra al Castellano
                          </h3>
                          <span className="text-[10px] font-mono font-medium text-amber-800 bg-amber-100 border border-amber-300 px-2 py-0.5 rounded-full">
                            Original: {selectedAnalysis.originalLanguage}
                          </span>
                        </div>
                        <p className="text-xs text-slate-600 leading-relaxed">
                          Puedes generar una traducción íntegra, completa y exhaustiva párrafo por párrafo de todo el artículo o material multimedia al castellano.
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={isTranslatingFull}
                        onClick={() => handleRequestFullTranslation(selectedAnalysis)}
                        className="inline-flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg text-xs font-semibold shadow-xs transition-colors shrink-0 disabled:opacity-50"
                      >
                        {isTranslatingFull ? (
                          <>
                            <RotateCcw className="w-4 h-4 animate-spin text-white" />
                            <span>Traduciendo íntegramente...</span>
                          </>
                        ) : (
                          <>
                            <Globe className="w-4 h-4 text-white" />
                            <span>Generar Traducción Íntegra</span>
                          </>
                        )}
                      </button>
                    </div>
                  ) : null}

                  {/* Bibliographic sources & Academic Verification Section */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-lg font-display font-semibold text-slate-900 flex items-center gap-2">
                            <BookOpen className="w-5 h-5 text-indigo-600" />
                            Gabinete de Fuentes Bibliográficas de Contraste
                          </h3>
                          <span className="text-[10px] font-mono font-bold text-emerald-800 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <Sparkles className="w-3 h-3 text-emerald-600" />
                            Datos Actualizados (2021-2026)
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-1">
                          Fuentes y publicaciones indexadas con máxima prioridad en los últimos 5 años (2021-2026) para contrastar la tesis central con indicadores, literatura y datos empíricos contemporáneos.
                        </p>
                      </div>
                    </div>

                    {/* Recharts Chart for Comparison */}
                    <div className="bg-slate-50 border border-slate-150 rounded-xl p-4 mb-6">
                      <h4 className="text-xs font-mono font-semibold text-slate-600 uppercase tracking-wider mb-4 flex items-center gap-1.5">
                        <Award className="w-4 h-4 text-amber-500" />
                        Índice Comparativo de Fiabilidad y Credibilidad
                      </h4>
                      <div className="h-60">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart
                            data={selectedAnalysis.bibliographicSources.filter((x) => typeof x.reliabilityScore === "number")}
                            margin={{ top: 10, right: 10, left: -20, bottom: 5 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                            <XAxis 
                              dataKey="author" 
                              tick={{ fontSize: 10, fill: "#64748b" }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <YAxis 
                              domain={[0, 100]} 
                              tick={{ fontSize: 10, fill: "#64748b" }}
                              axisLine={false}
                              tickLine={false}
                            />
                            <Tooltip
                              content={({ active, payload }) => {
                                if (active && payload && payload.length) {
                                  const data = payload[0].payload;
                                  return (
                                    <div className="bg-slate-900 text-white p-3 rounded-lg text-xs shadow-lg border border-slate-800 max-w-xs">
                                      <p className="font-semibold">{data.title}</p>
                                      <p className="text-[10px] text-slate-300 mt-1">Autor: {data.author} ({data.year})</p>
                                      <p className="text-xs font-mono mt-1 text-amber-400">Fiabilidad: {data.reliabilityScore}/100</p>
                                    </div>
                                  );
                                }
                                return null;
                              }}
                            />
                            <Bar dataKey="reliabilityScore" radius={[4, 4, 0, 0]} maxBarSize={45}>
                              {selectedAnalysis.bibliographicSources.filter((x) => typeof x.reliabilityScore === "number").map((entry, index) => (
                                <Cell 
                                  key={`cell-${index}`} 
                                  fill={(entry.reliabilityScore as number) >= 80 ? "#10b981" : (entry.reliabilityScore as number) >= 60 ? "#f59e0b" : "#f43f5e"} 
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Source Cards */}
                    <div className="space-y-6">
                      {selectedAnalysis.bibliographicSources.map((source, idx) => {
                        const firstAuthor = (source.author || "").split(",")[0].split(" y ")[0].trim();
                        const exactScholarQuery = `"${source.title}" ${firstAuthor}`.trim();
                        const exactJstorQuery = `"${source.title}"`;
                        const yearNum = parseInt(source.year || "2024", 10);
                        const isModern = !isNaN(yearNum) ? yearNum >= 2021 : (source.isRecent !== false);

                        return (
                          <div key={idx} className="border border-slate-150 rounded-xl p-5 hover:border-slate-350 transition-all bg-white shadow-xs">
                            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
                              <div className="space-y-1.5 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded">
                                    {source.type}
                                  </span>
                                  
                                  {/* Estado de verificación: el sello solo existe si la obra existe y coincide con el registro */}
                                  {(() => {
                                    const st = source.verificationStatus;
                                    if (st === "exact") return <span className="text-[10px] font-mono font-bold text-teal-700 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5 text-teal-600" />Verificada: existe y coincide</span>;
                                    if (st === "probable") return <span className="text-[10px] font-mono font-bold text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded">Coincidencia probable</span>;
                                    if (st === "not_found") return <span className="text-[10px] font-mono font-bold text-rose-800 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded">No verificada</span>;
                                    return <span className="text-[10px] font-mono font-bold text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">Verificación anterior (no fiable)</span>;
                                  })()}
                                  {source.year && <span className="text-[10px] font-mono text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">{source.year}</span>}
                                  {source.isRetracted && <span className="text-[10px] font-mono font-bold text-white bg-rose-600 px-2 py-0.5 rounded">RETRACTADA</span>}
                                  {source.citationsCount !== undefined && source.citationsCount !== null && (
                                    <span className="text-[10px] font-mono text-slate-600 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded">
                                      {source.citationsCount} citas
                                    </span>
                                  )}
                                </div>
                                <h4 className="font-display font-bold text-base text-slate-900 leading-snug">
                                  {source.title}
                                </h4>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 font-medium">
                                  <p>Autor/es: <span className="text-slate-800 font-semibold">{source.author}</span></p>
                                  {source.journalOrVenue && (
                                    <p>Revista / Editorial: <span className="text-slate-800 font-semibold italic">{source.journalOrVenue}</span></p>
                                  )}
                                </div>
                              </div>

                              {/* Score Display Card */}
                              <div className={`shrink-0 border rounded-lg px-3 py-1.5 flex flex-col items-center justify-center min-w-[100px] ${getScoreColor(source.reliabilityScore)}`}>
                                <span className="text-xs font-mono font-medium text-slate-500">Fiabilidad</span>
                                <span className="text-xl font-mono font-bold">{typeof source.reliabilityScore === "number" ? `${source.reliabilityScore}/100` : "—"}</span>
                              </div>
                            </div>

                            {/* Progress bar gauge */}
                            <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden mb-4">
                              <div className={`h-full ${getProgressBarColor(source.reliabilityScore)} rounded-full`} style={{ width: `${typeof source.reliabilityScore === "number" ? source.reliabilityScore : 0}%` }}></div>
                            </div>

                            {/* Currency reason banner */}
                            {source.currencyReason && (
                              <div className={`p-3 rounded-lg text-xs flex items-start gap-2 mb-4 border ${
                                isModern 
                                  ? 'bg-emerald-50/60 border-emerald-200/70 text-emerald-950' 
                                  : 'bg-amber-50/60 border-amber-200/70 text-amber-950'
                              }`}>
                                <Sparkles className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${isModern ? 'text-emerald-600' : 'text-amber-600'}`} />
                                <div className="space-y-0.5">
                                  <span className="font-semibold text-[11px] block">
                                    {isModern ? 'Vigencia de Datos & Actualización Empírica:' : 'Justificación de Recurso Seminal Histórico:'}
                                  </span>
                                  <p className="text-[11.5px] leading-relaxed text-slate-700">
                                    {source.currencyReason}
                                  </p>
                                </div>
                              </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-4 border-t border-slate-100 pt-4 text-xs">
                              <div className="space-y-2">
                                <h5 className="font-semibold text-slate-800 flex items-center gap-1">
                                  <FileText className="w-3.5 h-3.5 text-slate-500" />
                                  Sinopsis y Contribución <span className="font-normal text-slate-400">(redactada por el modelo, no verificada)</span>
                                </h5>
                                <p className="text-slate-600 leading-relaxed">{source.summary}</p>
                              </div>

                              <div className="space-y-2">
                                <h5 className="font-semibold text-slate-800 flex items-center gap-1">
                                  <Search className="w-3.5 h-3.5 text-indigo-600" />
                                  Análisis Crítico y Contraste <span className="font-normal text-slate-400">(según el modelo)</span>
                                </h5>
                                <p className="text-slate-600 leading-relaxed italic">"{source.criticalAnalysis}"</p>
                                {source.supportVerdict && (
                                  <p className={`not-italic text-[11px] leading-snug ${source.supportVerdict === "unrelated" ? "text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1" : "text-slate-500"}`}>
                                    <strong>Comprobado contra el resumen real de la obra:</strong> {SUPPORT_UI[source.supportVerdict]}.
                                    {source.supportQuote && <span className="italic"> «{source.supportQuote}»</span>}
                                  </p>
                                )}
                              </div>
                            </div>

                            <div className="mt-4 p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                              <div className="flex items-start sm:items-center gap-2">
                                <Award className="w-4 h-4 text-slate-400 mt-0.5 sm:mt-0 shrink-0" />
                                <span className="text-slate-600 font-mono text-[11px]">
                                  <strong className="text-slate-800">Evaluación del Rigor:</strong> {source.academicRigor}
                                </span>
                              </div>
                              
                              <div className="flex flex-wrap items-center gap-2 shrink-0 self-end lg:self-auto">
                                {source.doi && (
                                  <a
                                    href={source.doi}
                                    target="_blank"
                                    referrerPolicy="no-referrer"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 px-2.5 py-1 rounded-md transition-colors"
                                    title="Enlace DOI directo al artículo oficial"
                                  >
                                    DOI / Paper
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                                {source.openAccessUrl && (
                                  <a
                                    href={source.openAccessUrl}
                                    target="_blank"
                                    referrerPolicy="no-referrer"
                                    rel="noreferrer"
                                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-700 bg-teal-50 hover:bg-teal-100 border border-teal-200 px-2.5 py-1 rounded-md transition-colors"
                                    title="Descargar o leer texto completo en Open Access"
                                  >
                                    PDF Abierto
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                )}
                                <a
                                  href={`https://scholar.google.com/scholar?q=${encodeURIComponent(exactScholarQuery)}${isModern ? '&as_ylo=2021' : ''}`}
                                  target="_blank"
                                  referrerPolicy="no-referrer"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2.5 py-1 rounded-md transition-colors"
                                  title="Buscar este artículo en Google Scholar (filtrado para publicaciones recientes)"
                                >
                                  Google Scholar
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                                <a
                                  href={`https://www.jstor.org/action/doBasicSearch?Query=${encodeURIComponent(exactJstorQuery)}`}
                                  target="_blank"
                                  referrerPolicy="no-referrer"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-md transition-colors"
                                  title="Buscar el título exacto en JSTOR"
                                >
                                  JSTOR
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                </motion.div>
              ) : (
                <div className="bg-white border border-slate-200 rounded-xl p-12 text-center shadow-xs flex flex-col items-center justify-center min-h-[500px]">
                  <div className="p-4 bg-slate-50 rounded-full text-slate-400 mb-4 border border-slate-100">
                    <BookOpen className="w-12 h-12" />
                  </div>
                  <h3 className="text-lg font-display font-semibold text-slate-900 mb-1.5">No hay reporte activo</h3>
                  <p className="text-sm text-slate-500 max-w-sm mx-auto mb-6">
                    Sube una URL de Substack, blog, podcast o vídeo de YouTube, o pega un texto para realizar un profundo desglose académico y de fiabilidad.
                  </p>
                  
                  {/* Prompt recommendations box */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-lg text-left">
                    <div className="p-3.5 bg-slate-50 border border-slate-150 rounded-xl space-y-1.5">
                      <h4 className="text-xs font-semibold text-slate-800 flex items-center gap-1">
                        <Globe className="w-3.5 h-3.5 text-blue-500" />
                        Blogs e Internet
                      </h4>
                      <p className="text-[11px] text-slate-500 leading-relaxed">Artículos de opinión, ensayos complejos, o blogs como Medium y Substacks académicos.</p>
                    </div>

                    <div className="p-3.5 bg-slate-50 border border-slate-150 rounded-xl space-y-1.5">
                      <h4 className="text-xs font-semibold text-slate-800 flex items-center gap-1">
                        <Mic className="w-3.5 h-3.5 text-purple-500" />
                        Podcasts y YouTube
                      </h4>
                      <p className="text-[11px] text-slate-500 leading-relaxed">Vídeos con contenido de investigación o divulgación, debates intelectuales y geopolítica.</p>
                    </div>
                  </div>
                </div>
              )}
            </AnimatePresence>

          </div>

        </div>

      </main>

      <footer className="border-t border-slate-200 bg-white mt-16 py-8 text-center text-xs text-slate-400 font-mono">
        <p>© 2026 Lupa Crítica - Gabinete Académico de Rigor Cognitivo e Investigación.</p>
        <p className="mt-1">Implementando técnicas de traducción automática e investigación heurística con IA.</p>
      </footer>

      {/* Floating Action Bar for Quick Export when viewing a report */}
      {selectedAnalysis && !loading && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-slate-900/90 text-white backdrop-blur-md px-4 py-2.5 rounded-full shadow-xl border border-slate-700/80 flex items-center gap-3 animate-fadeIn">
          <div className="hidden sm:flex items-center gap-2 pr-2 border-r border-slate-700 max-w-[200px] truncate">
            {getContentTypeIcon(selectedAnalysis.contentType)}
            <span className="text-xs font-medium text-slate-200 truncate">{selectedAnalysis.title}</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => handleCopyNotion()}
              className={`text-xs px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-all font-medium cursor-pointer shadow-xs ${
                copiedNotion
                  ? "bg-emerald-500 text-white"
                  : "bg-indigo-600 hover:bg-indigo-500 text-white"
              }`}
              title="Copiar contenido formateado para Notion"
            >
              {copiedNotion ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedNotion ? "¡Copiado!" : "Copiar Notion"}</span>
            </button>

            <button
              onClick={() => handleDownloadMarkdown()}
              className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-100 hover:text-white px-3 py-1.5 rounded-full flex items-center gap-1.5 transition-all font-medium border border-slate-600 cursor-pointer shadow-xs"
              title="Descargar archivo Markdown (.md)"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              <span>Descargar .md</span>
            </button>
          </div>
        </div>
      )}

      {/* Delete Single Item Confirmation Modal */}
      {deleteTarget && (
        <div 
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => setDeleteTarget(null)}
        >
          <div 
            className="bg-white border border-slate-200 rounded-xl p-6 max-w-md w-full shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2.5 bg-rose-50 rounded-full border border-rose-100">
                <Trash2 className="w-5 h-5" />
              </div>
              <h3 className="text-base font-semibold font-display text-slate-900">¿Eliminar análisis del historial?</h3>
            </div>
            
            <p className="text-xs text-slate-600 leading-relaxed">
              Estás a punto de eliminar <strong className="text-slate-800">"{deleteTarget.title}"</strong>. Esta acción retirará el registro del panel y de la base de datos persistente.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
              <button
                onClick={() => setDeleteTarget(null)}
                className="text-xs px-3.5 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium cursor-pointer transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => executeDelete(deleteTarget.id)}
                className="text-xs px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium cursor-pointer transition-colors shadow-xs"
              >
                Sí, eliminar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear All Confirmation Modal */}
      {showClearAllModal && (
        <div 
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => setShowClearAllModal(false)}
        >
          <div 
            className="bg-white border border-slate-200 rounded-xl p-6 max-w-md w-full shadow-xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 text-rose-600">
              <div className="p-2.5 bg-rose-50 rounded-full border border-rose-100">
                <AlertCircle className="w-5 h-5" />
              </div>
              <h3 className="text-base font-semibold font-display text-slate-900">¿Vaciar todo el historial?</h3>
            </div>
            
            <p className="text-xs text-slate-600 leading-relaxed">
              Se eliminarán todos los {analyses.length} análisis almacenados de forma permanente.
            </p>

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-slate-100">
              <button
                onClick={() => setShowClearAllModal(false)}
                className="text-xs px-3.5 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium cursor-pointer transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={executeClearAll}
                className="text-xs px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-medium cursor-pointer transition-colors shadow-xs"
              >
                Vaciar todo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Correction & Fact Refinement Modal */}
      {showCorrectionModal && selectedAnalysis && (
        <div 
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn"
          onClick={() => !isApplyingCorrection && setShowCorrectionModal(false)}
        >
          <div 
            className="bg-white border border-slate-200 rounded-2xl p-6 max-w-xl w-full shadow-2xl space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5 text-amber-700">
                <div className="p-2 bg-amber-50 rounded-xl border border-amber-200">
                  <Edit3 className="w-5 h-5 text-amber-700" />
                </div>
                <div>
                  <h3 className="text-base font-bold font-display text-slate-900">
                    Propor Corrección ou Rectificación
                  </h3>
                  <p className="text-xs text-slate-500">
                    Sinala calquera dato, data, cifra ou candidato inexacto para que a app o rectifique
                  </p>
                </div>
              </div>
              <button
                onClick={() => !isApplyingCorrection && setShowCorrectionModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  ¿Que dato ou información é inexacta e como debe corrixirse?
                </label>
                <textarea
                  rows={4}
                  value={userCorrectionText}
                  onChange={(e) => setUserCorrectionText(e.target.value)}
                  placeholder="Exemplo: O BNG acadou 3 escanos nas eleccións xerais do ano 2000 (306.268 votos, 1,32%) e os deputados foron Francisco Rodríguez, Guillerme Vázquez e Carlos Aymerich..."
                  className="w-full p-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-500 focus:bg-white text-slate-800 font-sans"
                />
              </div>

              {/* Options */}
              <div className="p-3 bg-amber-50/70 border border-amber-200/80 rounded-xl space-y-2.5 text-xs text-slate-700">
                <label className="flex items-center gap-2.5 cursor-pointer font-medium">
                  <input
                    type="checkbox"
                    checked={correctionWebCheck}
                    onChange={(e) => setCorrectionWebCheck(e.target.checked)}
                    className="w-4 h-4 text-amber-600 rounded border-slate-300 focus:ring-amber-500"
                  />
                  <span>
                    <strong>Contrastar e verificar con busca web en tempo real</strong> (consulta bases de datos electorais e oficiais)
                  </span>
                </label>

                <div className="flex items-center justify-between pt-2 border-t border-amber-200/60">
                  <span className="font-semibold text-slate-700 flex items-center gap-1.5">
                    <Languages className="w-3.5 h-3.5 text-amber-700" />
                    Idioma de saída do informe rectificado:
                  </span>
                  <select
                    value={correctionTargetLang || selectedAnalysis.outputLanguage || "galego"}
                    onChange={(e) => setCorrectionTargetLang(e.target.value)}
                    className="text-xs bg-white border border-amber-300 rounded-md px-2 py-1 font-medium text-slate-800 focus:outline-none"
                  >
                    <option value="galego">Galego (Lingua Galega)</option>
                    <option value="castellano">Castellano (Español)</option>
                    <option value="català">Català</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-slate-100">
              <button
                onClick={() => setShowCorrectionModal(false)}
                disabled={isApplyingCorrection}
                className="text-xs px-3.5 py-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium cursor-pointer transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleApplyUserCorrection}
                disabled={isApplyingCorrection || !userCorrectionText.trim()}
                className="text-xs px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold cursor-pointer transition-colors shadow-xs flex items-center gap-1.5 disabled:opacity-40"
              >
                {isApplyingCorrection ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                    <span>Investigando e aplicando corrección...</span>
                  </>
                ) : (
                  <>
                    <Wand2 className="w-3.5 h-3.5" />
                    <span>Aplicar Corrección e Rectificar</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Lightbox Modal */}
      {viewingPhoto && (
        <div 
          className="fixed inset-0 z-50 bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-4 animate-fadeIn" 
          onClick={() => setViewingPhoto(null)}
        >
          <div 
            className="relative max-w-4xl max-h-[90vh] bg-white p-2 rounded-xl shadow-2xl overflow-hidden flex flex-col items-center" 
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setViewingPhoto(null)}
              className="absolute top-3 right-3 p-2 bg-slate-900/80 hover:bg-slate-900 text-white rounded-full transition-all z-10 cursor-pointer shadow-md"
              title="Cerrar vista previa"
            >
              <X className="w-5 h-5" />
            </button>
            <img src={viewingPhoto} alt="Fotografía del artículo ampliada" className="max-w-full max-h-[85vh] object-contain rounded-lg" />
          </div>
        </div>
      )}
    </div>
  );
}
