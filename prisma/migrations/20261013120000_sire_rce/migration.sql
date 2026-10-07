-- AlterEnum
ALTER TYPE "ResolucionDiferencia" ADD VALUE 'INCLUIDA';
ALTER TYPE "ResolucionDiferencia" ADD VALUE 'EXCLUIDA';

-- AlterTable
ALTER TABLE "diferencias_sire" ADD COLUMN "doc_numero" TEXT;

-- AlterTable
ALTER TABLE "documentos_comerciales" ADD COLUMN "detraccion_monto" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN "detraccion_constancia" TEXT,
ADD COLUMN "detraccion_fecha" DATE;

-- Excluir del registro también exige explicar por qué
-- (se compara como texto: los valores nuevos del enum no se pueden usar en la misma transacción)
ALTER TABLE diferencias_sire DROP CONSTRAINT diferencia_justificada_con_nota;
ALTER TABLE diferencias_sire ADD CONSTRAINT diferencia_justificada_con_nota
  CHECK (resolucion::text NOT IN ('JUSTIFICADA', 'EXCLUIDA') OR length(trim(coalesce(nota, ''))) >= 5);

ALTER TABLE documentos_comerciales ADD CONSTRAINT documento_detraccion_valida
  CHECK (detraccion_monto >= 0 AND (detraccion_constancia IS NULL OR detraccion_fecha IS NOT NULL));
