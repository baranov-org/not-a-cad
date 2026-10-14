{{- define "nac.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "nac.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "nac.selectorLabels" -}}
app.kubernetes.io/name: {{ include "nac.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "nac.labels" -}}
{{ include "nac.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* Secret holding DATABASE_URL, or empty for the embedded database */}}
{{- define "nac.dbSecret" -}}
{{- if eq .Values.database.mode "cnpg" -}}
{{ include "nac.fullname" . }}-pg-app
{{- else if eq .Values.database.mode "external" -}}
{{ required "database.existingSecret is required for database.mode=external" .Values.database.existingSecret }}
{{- end -}}
{{- end -}}

{{- define "nac.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{ .Values.publicUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.tls.enabled -}}
https://{{ .Values.ingress.host }}
{{- end -}}
{{- end -}}
