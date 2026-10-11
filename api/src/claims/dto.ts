import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export const CLAIM_STATUSES = ['filed', 'triaging', 'awaiting_review', 'approved', 'rejected', 'dead_lettered'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export class FaultEventDto {
  @ApiProperty({ example: 312 }) @IsInt() @Min(0) t!: number;
  @ApiProperty({ example: 'BMS-201' }) @Matches(/^[A-Z]{2,4}-[0-9]{3}$/) code!: string;
}

/** Shape check only. The triage service checks row widths, time order and numbers, and answers 422. */
export class RideLogDto {
  @ApiProperty({ enum: ['ridelog.v1'] }) @IsIn(['ridelog.v1']) format!: 'ridelog.v1';
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(10) hz!: number;
  @ApiProperty({ example: 'DEMORMX2500000101' }) @IsString() @Length(17, 17) vin!: string;
  @ApiProperty({ example: '4.1.2' }) @Matches(/^\d+\.\d+\.\d+$/) firmware!: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMinSize(2) @ArrayMaxSize(40) @IsString({ each: true }) columns!: string[];
  @ApiProperty({ type: 'array', items: { type: 'array', items: {} }, description: 'Rows at hz samples per second, one value per column' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20000)
  rows!: unknown[][];
  @ApiProperty({ type: [FaultEventDto] }) @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => FaultEventDto) fault_codes!: FaultEventDto[];
}

export class FileClaimDto {
  @ApiProperty({ example: 'DEMORMX2500000101' }) @IsString() @Length(17, 17) vin!: string;
  @ApiProperty({ example: 'Bike cuts power under hard acceleration.' }) @IsString() @Length(3, 2000) complaint!: string;
  @ApiProperty({ example: 4210 }) @IsInt() @Min(0) @Max(500000) odometer_km!: number;
  @ApiProperty({ type: RideLogDto }) @IsObject() @ValidateNested() @Type(() => RideLogDto) ride_log!: RideLogDto;
}

export class ListClaimsQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @ApiPropertyOptional({ description: 'Opaque cursor from the previous page (Link rel=next)' }) @IsOptional() @IsString() @MaxLength(400) cursor?: string;
  @ApiPropertyOptional({ enum: CLAIM_STATUSES }) @IsOptional() @IsIn(CLAIM_STATUSES as unknown as string[]) status?: ClaimStatus;
  @ApiPropertyOptional({ description: 'Ops and engineer keys only; dealer keys always see their own dealer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  dealer_id?: number;
}

export class ListClaimsV1QueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) page?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) per_page?: number;
}

export class PartEditDto {
  @ApiProperty({ example: '41-2207' }) @Matches(/^\d{2}-\d{4}$/) part_number!: string;
  @ApiProperty({ example: 'Battery module, 12 cell group' }) @IsString() @Length(2, 80) description!: string;
  @ApiProperty({ example: 1 }) @IsInt() @Min(1) @Max(20) qty!: number;
}

export class RepairEditDto {
  @ApiPropertyOptional({ example: 2.0 }) @IsOptional() @IsNumber() @Min(0) @Max(20) labour_hours?: number;
  @ApiPropertyOptional({ type: [PartEditDto] }) @IsOptional() @IsArray() @ArrayMaxSize(8) @ValidateNested({ each: true }) @Type(() => PartEditDto) parts?: PartEditDto[];
}

export class TriageDecisionDto {
  @ApiProperty({ enum: ['approve', 'reject'] }) @IsIn(['approve', 'reject']) action!: 'approve' | 'reject';
  @ApiPropertyOptional({ type: RepairEditDto, description: 'Engineer changes to the suggested repair (approve only)' })
  @IsOptional()
  @ValidateNested()
  @Type(() => RepairEditDto)
  repair?: RepairEditDto;
  @ApiPropertyOptional({ example: 'Labour raised: module is behind the swingarm guard.' }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}
