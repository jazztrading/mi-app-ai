import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
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
  Coins
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

interface BibliographicSource {
  title: string;
  author: string;
  year?: string;
  type: string;
  link: string;
  summary: string;
  criticalAnalysis: string;
  reliabilityScore: number;
  academicRigor: string;
}

interface CriticalPosition {
  title: string;
  argument: string;
  scientificBasis: string;
}

interface ConstructiveDebatesSummary {
  overview: string;
  keyQuestions: string[];
  consensusAndDisagreements?: string;
}

interface GlossaryTerm {
  term: string;
  definition: string;
  referenceUrl: string;
}

interface NumericalExample {
  concept: string;
  figureOrCost: string;
  explanation: string;
}

interface AnalysisResult {
  id: string;
  url: string;
  title: string;
  originalLanguage: string;
  isSpanishOrGalician: boolean;
  categories: string[];
  translation?: string;
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
  const [analyses, setAnalyses] = useState<AnalysisResult[]>([]);
  const [selectedAnalysis, setSelectedAnalysis] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch past analyses on load & sync with localStorage
  useEffect(() => {
    fetchAnalyses();
  }, []);

  const fetchAnalyses = async () => {
    try {
      const res = await fetch("/api/analyses");
      if (res.ok) {
        const data: AnalysisResult[] = await res.json();
        
        // Merge with localStorage if available for extra durability
        let localData: AnalysisResult[] = [];
        try {
          const saved = localStorage.getItem("lupa_critica_history");
          if (saved) localData = JSON.parse(saved);
        } catch {
          // ignore
        }

        // Combine unique analyses by ID
        const map = new Map<string, AnalysisResult>();
        data.forEach(item => map.set(item.id, item));
        localData.forEach(item => {
          if (!map.has(item.id)) map.set(item.id, item);
        });

        const combined = Array.from(map.values()).sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt));
        setAnalyses(combined);
        try {
          localStorage.setItem("lupa_critica_history", JSON.stringify(combined));
        } catch {}

        if (combined.length > 0 && !selectedAnalysis) {
          setSelectedAnalysis(combined[0]);
        }
      }
    } catch (err) {
      console.error("Error al cargar históricos desde el servidor:", err);
      // Fallback to localStorage
      try {
        const saved = localStorage.getItem("lupa_critica_history");
        if (saved) {
          const localData: AnalysisResult[] = JSON.parse(saved);
          setAnalyses(localData);
          if (localData.length > 0 && !selectedAnalysis) {
            setSelectedAnalysis(localData[0]);
          }
        }
      } catch {}
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
      "Buscando fuentes bibliográficas de contraste en Scholar (2021-2026)..."
    ] : isPhotoTab ? [
      "Iniciando escaneo visual y motor OCR en la fotografía...",
      "Extrayendo titulares, columnas y gráficos del recorte de prensa...",
      "Analizando el contenido de la imagen e identificando el idioma...",
      "Traduciendo y adaptando conceptos clave al castellano...",
      "Generando resumen ejecutivo y posiciones críticas universitarias...",
      "Buscando fuentes bibliográficas de contraste (2021-2026)..."
    ] : [
      "Iniciando raspado y extracción de datos del recurso...",
      "Analizando la estructura y el idioma del contenido original...",
      "Traduciendo y adaptando conceptos clave al castellano...",
      "Generando resumen ejecutivo y destilando puntos clave...",
      "Buscando fuentes bibliográficas, ensayos y papers complementarios...",
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

      const res = await fetch("/api/analyze", {
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

  const deleteAnalysis = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("¿Seguro que deseas eliminar este análisis del histórico?")) return;

    try {
      const res = await fetch(`/api/analyses/${id}`, { method: "DELETE" });
      if (res.ok) {
        setAnalyses(prev => {
          const updated = prev.filter(item => item.id !== id);
          try {
            localStorage.setItem("lupa_critica_history", JSON.stringify(updated));
          } catch {}
          return updated;
        });
        if (selectedAnalysis?.id === id) {
          setSelectedAnalysis(null);
        }
      }
    } catch (err) {
      console.error("Error al eliminar:", err);
    }
  };

  // Helper to get score color
  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-emerald-600 bg-emerald-50 border-emerald-200";
    if (score >= 60) return "text-amber-600 bg-amber-50 border-amber-200";
    return "text-rose-600 bg-rose-50 border-rose-200";
  };

  const getProgressBarColor = (score: number) => {
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

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-slate-200">
      {/* Top Professional Header */}
      <header className="border-b border-slate-200 bg-white sticky top-0 z-50 shadow-xs">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 bg-slate-900 text-white rounded-lg shadow-sm">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-display font-bold tracking-tight text-slate-900 flex items-center gap-2">
                Lupa Crítica <span className="text-xs font-mono font-medium px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full border border-slate-200">Verificador Académico</span>
              </h1>
              <p className="text-xs text-slate-500">Deconstrucción, traducción y verificación de fuentes para blogs, podcasts y vídeos científicos o de divulgación.</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-slate-500 bg-slate-100 px-3 py-1.5 rounded-md border border-slate-200 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              Gabinete Activo
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
                <div className="mt-4 p-3 bg-rose-50 border border-rose-100 rounded-lg text-xs text-rose-700 flex items-start gap-2 animate-fadeIn">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-500" />
                  <span>{error}</span>
                </div>
              )}
            </div>

            {/* History Panel */}
            <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-xs">
              <h2 className="text-base font-display font-semibold text-slate-900 mb-3 flex items-center gap-2">
                <Layers className="w-5 h-5 text-slate-700" />
                Histórico de Análisis
              </h2>
              <p className="text-xs text-slate-500 mb-4">Selecciona cualquier recurso analizado para desplegar sus resultados académicos.</p>

              <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                {analyses.length === 0 ? (
                  <div className="py-6 text-center border-2 border-dashed border-slate-100 rounded-lg text-slate-400">
                    <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <span className="text-xs">No hay análisis registrados todavía</span>
                  </div>
                ) : (
                  analyses.map((item) => (
                    <div
                      key={item.id}
                      onClick={() => setSelectedAnalysis(item)}
                      className={`p-3 rounded-lg border transition-all cursor-pointer relative group flex items-start justify-between gap-2 ${
                        selectedAnalysis?.id === item.id
                          ? "border-slate-900 bg-slate-50 shadow-xs"
                          : "border-slate-150 hover:border-slate-300 hover:bg-slate-50/50"
                      }`}
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className="mt-0.5 shrink-0">
                          {getContentTypeIcon(item.contentType)}
                        </div>
                        <div className="min-w-0">
                          <h4 className="text-xs font-semibold text-slate-800 truncate leading-tight pr-4">
                            {item.title}
                          </h4>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] font-mono text-slate-400">
                              {new Date(item.analyzedAt).toLocaleDateString("es-ES")}
                            </span>
                            <span className="text-[10px] font-mono text-indigo-600 bg-indigo-50 border border-indigo-100 px-1.5 py-0.2 rounded-full font-medium">
                              {item.originalLanguage.toUpperCase()}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={(e) => deleteAnalysis(item.id, e)}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-rose-50 hover:text-rose-600 rounded text-slate-400 transition-all absolute right-2 top-2.5 cursor-pointer"
                        title="Eliminar registro"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))
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
                      
                      <div className="flex items-center gap-2">
                        {selectedAnalysis.url && (
                          <a
                            href={selectedAnalysis.url}
                            target="_blank"
                            referrerPolicy="no-referrer"
                            rel="noreferrer"
                            className="text-xs text-indigo-600 bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 px-3 py-1.5 rounded-lg flex items-center gap-1 transition-all"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                            Ver Recurso Original
                          </a>
                        )}
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

                      {!selectedAnalysis.isSpanishOrGalician && (
                        <span className="text-[10px] font-mono font-semibold text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                          Requiere Traducción
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Executive Summary Section */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
                    <h3 className="text-lg font-display font-semibold text-slate-900 mb-4 flex items-center gap-2">
                      <FileCheck className="w-5 h-5 text-slate-700" />
                      Resumen Ejecutivo Automático
                    </h3>
                    <div className="prose prose-slate max-w-none text-slate-700 text-sm leading-relaxed whitespace-pre-line">
                      {selectedAnalysis.executiveSummary}
                    </div>
                  </div>

                  {/* Staged Key points list */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
                    <h3 className="text-lg font-display font-semibold text-slate-900 mb-4 flex items-center gap-2">
                      <Sparkles className="w-5 h-5 text-indigo-600" />
                      Puntos Clave Extraídos
                    </h3>
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

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
                        {selectedAnalysis.numericalExamples.map((item, idx) => (
                          <div key={idx} className="p-4 bg-emerald-900/60 border border-emerald-800 rounded-lg space-y-2 flex flex-col justify-between">
                            <div>
                              <div className="flex items-center justify-between gap-2 mb-1.5">
                                <span className="text-xs font-semibold text-emerald-200">
                                  {item.concept}
                                </span>
                                <span className="text-xs font-mono font-bold text-amber-300 bg-amber-950/80 border border-amber-800/60 px-2 py-0.5 rounded shrink-0">
                                  {item.figureOrCost}
                                </span>
                              </div>
                              <p className="text-xs text-emerald-100/90 leading-relaxed font-sans">
                                {item.explanation}
                              </p>
                            </div>
                          </div>
                        ))}
                      </div>
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
                          <div key={idx} className="p-4 bg-rose-50/40 border border-rose-150 rounded-lg space-y-2">
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
                          Nivel Universitario
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 mb-5">
                        Explicaciones pedagógicas e intuitivas sin asunción de conocimientos previos para facilitar la comprensión de los términos técnicos y filosóficos más complejos:
                      </p>

                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {selectedAnalysis.glossary.map((item, idx) => (
                          <div key={idx} className="p-4 bg-white/90 border border-amber-200/70 rounded-lg shadow-xs flex flex-col justify-between space-y-3 hover:border-amber-300 transition-colors">
                            <div className="space-y-1.5">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
                                  Concepto #{idx + 1}
                                </span>
                                <h4 className="font-display font-bold text-sm text-slate-900">
                                  {item.term}
                                </h4>
                              </div>
                              <p className="text-xs text-slate-700 leading-relaxed font-sans">
                                {item.definition}
                              </p>
                            </div>

                            {item.referenceUrl && (
                              <div className="pt-2 border-t border-amber-100/80 flex justify-end">
                                <a
                                  href={item.referenceUrl}
                                  target="_blank"
                                  referrerPolicy="no-referrer"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200/80 px-2.5 py-1 rounded-md transition-colors"
                                  title={`Consultar fuente educativa para ${item.term}`}
                                >
                                  Saber más
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Translation display (Conditional on NOT spanish/galician) */}
                  {selectedAnalysis.translation && (
                    <div className="bg-slate-50 border border-amber-200 rounded-xl p-6 shadow-xs relative overflow-hidden">
                      <div className="absolute right-0 top-0 w-24 h-24 bg-amber-500/5 rounded-full blur-xl"></div>
                      <div className="flex items-center gap-2 mb-3">
                        <Globe className="w-5 h-5 text-amber-600" />
                        <h3 className="text-lg font-display font-semibold text-slate-900">Transcripción y Traducción Exhaustiva al Castellano</h3>
                        <span className="text-[10px] font-mono font-medium text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                          Versión Completa
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mb-4">
                        El original fue detectado en <strong className="text-slate-700">{selectedAnalysis.originalLanguage}</strong>. A continuación se proporciona la traducción extensa estructurada sección por sección:
                      </p>
                      <div className="p-5 bg-white border border-slate-200 rounded-lg text-sm leading-relaxed text-slate-800 font-sans max-h-[600px] overflow-y-auto whitespace-pre-line shadow-inner">
                        {selectedAnalysis.translation}
                      </div>
                    </div>
                  )}

                  {/* Bibliographic sources & Academic Verification Section */}
                  <div className="bg-white border border-slate-200 rounded-xl p-6 shadow-xs">
                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-4 border-b border-slate-100">
                      <div>
                        <h3 className="text-lg font-display font-semibold text-slate-900 flex items-center gap-2">
                          <BookOpen className="w-5 h-5 text-indigo-600" />
                          Gabinete de Fuentes Bibliográficas de Contraste
                        </h3>
                        <p className="text-xs text-slate-500 mt-0.5">Fuentes de alto rigor académico para verificar la veracidad o abrir debate sobre la tesis central.</p>
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
                            data={selectedAnalysis.bibliographicSources}
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
                                      <p className="text-[10px] text-slate-300 mt-1">Autor: {data.author}</p>
                                      <p className="text-xs font-mono mt-1 text-amber-400">Fiabilidad: {data.reliabilityScore}/100</p>
                                    </div>
                                  );
                                }
                                return null;
                              }}
                            />
                            <Bar dataKey="reliabilityScore" radius={[4, 4, 0, 0]} maxBarSize={45}>
                              {selectedAnalysis.bibliographicSources.map((entry, index) => (
                                <Cell 
                                  key={`cell-${index}`} 
                                  fill={entry.reliabilityScore >= 80 ? "#10b981" : entry.reliabilityScore >= 60 ? "#f59e0b" : "#f43f5e"} 
                                />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                    {/* Source Cards */}
                    <div className="space-y-6">
                      {selectedAnalysis.bibliographicSources.map((source, idx) => (
                        <div key={idx} className="border border-slate-150 rounded-xl p-5 hover:border-slate-350 transition-all bg-white shadow-xs">
                          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4 mb-4">
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-[10px] font-mono font-semibold uppercase tracking-wider text-indigo-600 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded">
                                  {source.type}
                                </span>
                                {source.year && (
                                  <span className="text-[10px] font-mono font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded flex items-center gap-1">
                                    <Calendar className="w-3 h-3" />
                                    {source.year}
                                  </span>
                                )}
                                <h4 className="font-display font-bold text-base text-slate-900 leading-snug">
                                  {source.title}
                                </h4>
                              </div>
                              <p className="text-xs text-slate-500 font-medium">Autor / Creador: <span className="text-slate-800 font-semibold">{source.author}</span></p>
                            </div>

                            {/* Score Display Card */}
                            <div className={`shrink-0 border rounded-lg px-3 py-1.5 flex flex-col items-center justify-center min-w-[100px] ${getScoreColor(source.reliabilityScore)}`}>
                              <span className="text-xs font-mono font-medium text-slate-500">Fiabilidad</span>
                              <span className="text-xl font-mono font-bold">{source.reliabilityScore}/100</span>
                            </div>
                          </div>

                          {/* Progress bar gauge */}
                          <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden mb-4">
                            <div className={`h-full ${getProgressBarColor(source.reliabilityScore)} rounded-full`} style={{ width: `${source.reliabilityScore}%` }}></div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-4 border-t border-slate-100 pt-4 text-xs">
                            <div className="space-y-2">
                              <h5 className="font-semibold text-slate-800 flex items-center gap-1">
                                <FileText className="w-3.5 h-3.5 text-slate-500" />
                                Sinopsis y Contribución
                              </h5>
                              <p className="text-slate-600 leading-relaxed">{source.summary}</p>
                            </div>

                            <div className="space-y-2">
                              <h5 className="font-semibold text-slate-800 flex items-center gap-1">
                                <Search className="w-3.5 h-3.5 text-indigo-600" />
                                Análisis Crítico y Contraste
                              </h5>
                              <p className="text-slate-600 leading-relaxed italic">"{source.criticalAnalysis}"</p>
                            </div>
                          </div>

                          <div className="mt-4 p-3 bg-slate-50 border border-slate-100 rounded-lg text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div className="flex items-start sm:items-center gap-2">
                              <Award className="w-4 h-4 text-slate-400 mt-0.5 sm:mt-0 shrink-0" />
                              <span className="text-slate-600 font-mono text-[11px]">
                                <strong className="text-slate-800">Evaluación del Rigor:</strong> {source.academicRigor}
                              </span>
                            </div>
                            
                            <div className="flex flex-wrap items-center gap-2 shrink-0 self-end sm:self-auto">
                              <a
                                href={`https://scholar.google.com/scholar?q=${encodeURIComponent(`${source.title} ${source.author}`)}`}
                                target="_blank"
                                referrerPolicy="no-referrer"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-2.5 py-1 rounded-md transition-colors"
                                title="Buscar este artículo directamente en Google Scholar"
                              >
                                Google Scholar
                                <ExternalLink className="w-3 h-3" />
                              </a>
                              <a
                                href={`https://www.jstor.org/action/doBasicSearch?Query=${encodeURIComponent(source.title)}`}
                                target="_blank"
                                referrerPolicy="no-referrer"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-700 bg-white hover:bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-md transition-colors"
                                title="Buscar en JSTOR"
                              >
                                JSTOR
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            </div>
                          </div>
                        </div>
                      ))}
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
