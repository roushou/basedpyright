/*
 * pyright.ts
 * Copyright (c) Microsoft Corporation.
 * Licensed under the MIT license.
 * Author: Eric Traut
 *
 * Command-line entry point for pyright type checker.
 */

// Add the start timer at the very top of the file, before we import other modules.

/* eslint-disable */
import { timingStats } from './common/timing';
/* eslint-enable */

import chalk from 'chalk';
import commandLineArgs, { CommandLineOptions, OptionDefinition } from 'command-line-args';
import * as os from 'os';

import { ChildProcess, fork } from 'child_process';
import { AnalysisResults } from './analyzer/analysis';
import { PackageTypeReport, TypeKnownStatus } from './analyzer/packageTypeReport';
import { PackageTypeVerifier } from './analyzer/packageTypeVerifier';
import { AnalyzerService } from './analyzer/service';
import { maxSourceFileSize } from './analyzer/sourceFile';
import { SourceFileInfo } from './analyzer/sourceFileInfo';
import { initializeDependencies } from './common/asyncInitialization';
import { ChokidarFileWatcherProvider } from './common/chokidarFileWatcherProvider';
import { CommandLineOptions as PyrightCommandLineOptions } from './common/commandLineOptions';
import { ConsoleInterface, LogLevel, StandardConsole, StderrConsole } from './common/console';
import { fail } from './common/debug';
import { createDeferred, Deferred } from './common/deferred';
import { Diagnostic, DiagnosticCategory } from './common/diagnostic';
import { FileDiagnostics } from './common/diagnosticSink';
import { FullAccessHost } from './common/fullAccessHost';
import { combinePaths, normalizePath } from './common/pathUtils';
import { PythonVersion } from './common/pythonVersion';
import { RealTempFile, createFromRealFileSystem } from './common/realFileSystem';
import { ServiceKeys } from './common/serviceKeys';
import { ServiceProvider } from './common/serviceProvider';
import { createServiceProvider } from './common/serviceProviderExtensions';
import { getStdin } from './common/streamUtils';
import { Position, Range, isEmptyRange } from './common/textRange';
import { Uri } from './common/uri/uri';
import { getFileSpec, tryStat } from './common/uri/uriUtils';
import { PyrightFileSystem } from './pyrightFileSystem';
import { toolName } from './constants';
import version from './version.json';
import * as core from '@actions/core';
import * as command from '@actions/core/lib/command';
import { convertDiagnostics } from 'pyright-to-gitlab-ci/src/converter';
import path from 'path';
import { pluralize } from './common/stringUtils';
import {
    allTypeCheckingModes,
    ConfigOptions,
    getBooleanDiagnosticRules,
    getDiagLevelDiagnosticRules,
} from './common/configOptions';
import { writeFileSync } from 'fs';

type SeverityLevel = 'error' | 'warning' | 'information';

// These values are publicly documented. Do not change them.
enum ExitStatus {
    NoErrors = 0,
    ErrorsReported = 1,
    FatalError = 2,
    ConfigFileParseError = 3,
    ParameterError = 4,
}

// The schema for this object is publicly documented. Do not change it.
interface PyrightJsonResults {
    version: string;
    time: string;
    generalDiagnostics: PyrightJsonDiagnostic[];
    summary: PyrightJsonSummary;
    typeCompleteness?: PyrightTypeCompletenessReport;
}

// The schema for this object is publicly documented. Do not change it.
interface PyrightSymbolCount {
    withKnownType: number;
    withAmbiguousType: number;
    withUnknownType: number;
}

// The schema for this object is publicly documented. Do not change it.
interface PyrightTypeCompletenessReport {
    packageName: string;
    packageRootDirectory?: string | undefined;
    moduleName: string;
    moduleRootDirectory?: string | undefined;
    ignoreUnknownTypesFromImports: boolean;
    pyTypedPath?: string | undefined;
    exportedSymbolCounts: PyrightSymbolCount;
    otherSymbolCounts: PyrightSymbolCount;
    missingFunctionDocStringCount: number;
    missingClassDocStringCount: number;
    missingDefaultParamCount: number;
    completenessScore: number;
    modules: PyrightPublicModuleReport[];
    symbols: PyrightPublicSymbolReport[];
}

// The schema for this object is publicly documented. Do not change it.
interface PyrightPublicModuleReport {
    name: string;
}

// The schema for this object is publicly documented. Do not change it.
interface PyrightPublicSymbolReport {
    category: string;
    name: string;
    referenceCount: number;
    isTypeKnown: boolean;
    isTypeAmbiguous: boolean;
    isExported: boolean;
    diagnostics: PyrightJsonDiagnostic[];
    alternateNames?: string[] | undefined;
}

// The schema for this object is publicly documented. Do not change it.
interface PyrightJsonDiagnostic {
    file: string;
    cell: number | undefined;
    severity: SeverityLevel;
    message: string;
    range?: Range | undefined;
    rule?: string | undefined;
}

// The schema for this object is publicly documented. Do not change it.
interface PyrightJsonSummary {
    filesAnalyzed: number;
    errorCount: number;
    warningCount: number;
    informationCount: number;
    timeInSec: number;
}

// The schema for this object is publicly documented. Do not change it.
interface DiagnosticResult {
    errorCount: number;
    warningCount: number;
    informationCount: number;
    diagnosticCount: number;
}

const cancellationNone = Object.freeze({
    isCancellationRequested: false,
    onCancellationRequested: function () {
        return {
            dispose() {
                /* empty */
            },
        };
    },
});

async function processArgs(): Promise<ExitStatus> {
    const optionDefinitions: OptionDefinition[] = [
        { name: 'createstub', type: String },
        { name: 'dependencies', type: Boolean },
        { name: 'files', type: String, multiple: true, defaultOption: true },
        { name: 'help', alias: 'h', type: Boolean },
        { name: 'ignoreexternal', type: Boolean },
        { name: 'lib', type: Boolean },
        { name: 'level', type: String },
        { name: 'outputjson', type: Boolean },
        { name: 'gitlabcodequality', type: String },
        { name: 'writebaseline', type: Boolean },
        { name: 'project', alias: 'p', type: String },
        { name: 'pythonpath', type: String },
        { name: 'pythonplatform', type: String },
        { name: 'pythonversion', type: String },
        { name: 'skipunannotated', type: Boolean },
        { name: 'stats', type: Boolean },
        { name: 'threads', type: parseThreadsArgValue },
        { name: 'typeshed-path', type: String },
        { name: 'baseline-file', type: String },
        { name: 'typeshedpath', alias: 't', type: String },
        { name: 'venv-path', type: String },
        { name: 'venvpath', alias: 'v', type: String },
        { name: 'verifytypes', type: String },
        { name: 'verbose', type: Boolean },
        { name: 'version', type: Boolean },
        { name: 'warnings', type: Boolean },
        { name: 'watch', alias: 'w', type: Boolean },
        // undocumented option only used internally for generating docs. pretty cringe but it's the least messy way i could think of to do it
        { name: 'printdiagnosticrulesets', type: Boolean },
    ];

    let args: CommandLineOptions;

    try {
        args = commandLineArgs(optionDefinitions);
    } catch (e: any) {
        const argErr: { name: string; optionName: string } = e;
        if (argErr && argErr.optionName) {
            console.error(`Unexpected option ${argErr.optionName}.\n${toolName} --help for usage`);
            return ExitStatus.ParameterError;
        }

        console.error(`Unexpected error\n${toolName} --help for usage`);
        return ExitStatus.ParameterError;
    }
    if (args.printdiagnosticrulesets) {
        console.log(
            JSON.stringify(
                [...getBooleanDiagnosticRules(true), ...getDiagLevelDiagnosticRules()].map((rule) => ({
                    'Diagnostic Rule': rule,
                    ...Object.fromEntries(
                        allTypeCheckingModes.map((typeCheckingMode) => [
                            typeCheckingMode,
                            ConfigOptions.getDiagnosticRuleSet(typeCheckingMode)[rule],
                        ])
                    ),
                }))
            )
        );
        return ExitStatus.NoErrors;
    }
    if (args.help !== undefined) {
        printUsage();
        return ExitStatus.NoErrors;
    }

    if (args.version !== undefined) {
        printVersion(console);
        return ExitStatus.NoErrors;
    }

    for (const [arg, value] of Object.entries(args)) {
        if (value === null && arg !== 'threads') {
            console.error(`'${arg}' option requires a value`);
            return ExitStatus.ParameterError;
        }
    }

    if (args.outputjson) {
        const incompatibleArgs = ['stats', 'verbose', 'createstub', 'dependencies'];
        for (const arg of incompatibleArgs) {
            if (args[arg] !== undefined) {
                console.error(`'outputjson' option cannot be used with '${arg}' option`);
                return ExitStatus.ParameterError;
            }
        }
    }

    if (args.verifytypes !== undefined) {
        const incompatibleArgs = ['watch', 'stats', 'createstub', 'dependencies', 'skipunannotated', 'threads'];
        for (const arg of incompatibleArgs) {
            if (args[arg] !== undefined) {
                console.error(`'verifytypes' option cannot be used with '${arg}' option`);
                return ExitStatus.ParameterError;
            }
        }
    }

    if (args.createstub) {
        const incompatibleArgs = ['watch', 'stats', 'verifytypes', 'dependencies', 'skipunannotated', 'threads'];
        for (const arg of incompatibleArgs) {
            if (args[arg] !== undefined) {
                console.error(`'createstub' option cannot be used with '${arg}' option`);
                return ExitStatus.ParameterError;
            }
        }
    }

    if (args.threads) {
        const incompatibleArgs = ['watch', 'stats', 'dependencies'];
        for (const arg of incompatibleArgs) {
            if (args[arg] !== undefined) {
                console.error(`'threads' option cannot be used with '${arg}' option`);
                return ExitStatus.ParameterError;
            }
        }
    }

    const options = new PyrightCommandLineOptions(process.cwd(), false);
    const tempFile = new RealTempFile();

    // Assume any relative paths are relative to the working directory.
    if (args.files && Array.isArray(args.files)) {
        let fileSpecList = args.files;

        // Has the caller indicated that the file list will be supplied by stdin?
        if (args.files.length === 1 && args.files[0] === '-') {
            try {
                const stdText = await getStdin();
                fileSpecList = stdText
                    .replace(/[\r\n]/g, ' ')
                    .trim()
                    .split(' ')
                    .map((s) => s.trim())
                    .filter((s) => !!s);
            } catch (e) {
                console.error('Invalid file list specified by stdin input');
                return ExitStatus.ParameterError;
            }
        }

        options.configSettings.includeFileSpecsOverride = fileSpecList;
        options.configSettings.includeFileSpecsOverride = options.configSettings.includeFileSpecsOverride.map((f) =>
            combinePaths(process.cwd(), f)
        );

        // Verify the specified file specs to make sure their wildcard roots exist.
        const tempFileSystem = new PyrightFileSystem(createFromRealFileSystem(tempFile));

        for (const fileDesc of options.configSettings.includeFileSpecsOverride) {
            const includeSpec = getFileSpec(Uri.file(process.cwd(), tempFile), fileDesc);
            try {
                const stat = tryStat(tempFileSystem, includeSpec.wildcardRoot);
                if (!stat) {
                    console.error(`File or directory "${includeSpec.wildcardRoot}" does not exist`);
                    return ExitStatus.ParameterError;
                }
            } catch {
                // Ignore exception in this case.
            }
        }
    }

    if (args.project) {
        options.configFilePath = combinePaths(process.cwd(), normalizePath(args.project));
    }

    if (args.pythonplatform) {
        if (['All', 'Darwin', 'Linux', 'Windows'].includes(args.pythonplatform)) {
            options.configSettings.pythonPlatform = args.pythonplatform;
        } else {
            console.error(
                `'${args.pythonplatform}' is not a supported Python platform; specify All, Darwin, Linux, or Windows`
            );
            return ExitStatus.ParameterError;
        }
    }

    if (args.pythonversion) {
        const version = PythonVersion.fromString(args.pythonversion);
        if (version) {
            options.configSettings.pythonVersion = version;
        } else {
            console.error(`'${args.pythonversion}' is not a supported Python version; specify 3.3, 3.4, etc.`);
            return ExitStatus.ParameterError;
        }
    }

    if (args.pythonpath !== undefined) {
        const incompatibleArgs = ['venv-path', 'venvpath'];
        for (const arg of incompatibleArgs) {
            if (args[arg] !== undefined) {
                console.error(`'pythonpath' option cannot be used with '${arg}' option`);
                return ExitStatus.ParameterError;
            }
        }

        options.configSettings.pythonPath = combinePaths(process.cwd(), normalizePath(args['pythonpath']));
    }

    if (args['venv-path']) {
        console.warn(`'venv-path' option is deprecated; use 'venvpath' instead`);
        options.configSettings.venvPath = combinePaths(process.cwd(), normalizePath(args['venv-path']));
    }

    if (args['venvpath']) {
        options.configSettings.venvPath = combinePaths(process.cwd(), normalizePath(args['venvpath']));
    }

    if (args['typeshed-path']) {
        console.warn(`'typeshed-path' option is deprecated; use 'typeshedpath' instead`);
        options.configSettings.typeshedPath = combinePaths(process.cwd(), normalizePath(args['typeshed-path']));
    }

    if (args['typeshedpath']) {
        options.configSettings.typeshedPath = combinePaths(process.cwd(), normalizePath(args['typeshedpath']));
    }

    if (args['baseline-file']) {
        options.configSettings.baselineFile = combinePaths(process.cwd(), normalizePath(args['baseline-file']));
    }

    if (args.createstub) {
        options.languageServerSettings.typeStubTargetImportName = args.createstub;
    }

    if (args.skipunannotated) {
        options.configSettings.analyzeUnannotatedFunctions = false;
    }

    if (args.verbose) {
        options.configSettings.verboseOutput = true;
    }

    // Always enable autoSearchPaths when using the command line.
    options.configSettings.autoSearchPaths = true;

    if (args.lib) {
        console.warn(`The --lib option is deprecated. Pyright now defaults to using library code to infer types.`);
    }

    let minSeverityLevel: SeverityLevel = 'information';
    if (args.level && typeof args.level === 'string') {
        const levelValue = args.level.toLowerCase();
        if (levelValue === 'error' || levelValue === 'warning') {
            minSeverityLevel = levelValue;
        } else {
            console.error(`'${args.level}' is not a valid value for --level; specify error or warning.`);
            return ExitStatus.ParameterError;
        }
    }

    options.languageServerSettings.checkOnlyOpenFiles = false;

    if (!!args.stats && !!args.verbose) {
        options.languageServerSettings.logTypeEvaluationTime = true;
    }

    let logLevel = LogLevel.Error;
    if (args.stats || args.verbose) {
        logLevel = LogLevel.Info;
    }

    // If using outputjson, redirect all console output to stderr so it doesn't mess
    // up the JSON output, which goes to stdout.
    const output = args.outputjson ? new StderrConsole(logLevel) : new StandardConsole(logLevel);
    const fileSystem = new PyrightFileSystem(
        createFromRealFileSystem(tempFile, output, new ChokidarFileWatcherProvider(output))
    );

    const serviceProvider = createServiceProvider(fileSystem, output, tempFile);

    // The package type verification uses a different path.
    if (args['verifytypes'] !== undefined) {
        return verifyPackageTypes(
            serviceProvider,
            args['verifytypes'] || '',
            options,
            !!args.outputjson,
            minSeverityLevel,
            args['ignoreexternal']
        );
    } else if (args['ignoreexternal'] !== undefined) {
        console.error(`'--ignoreexternal' is valid only when used with '--verifytypes'`);
        return ExitStatus.ParameterError;
    }

    const watch = args.watch !== undefined;
    options.languageServerSettings.watchForSourceChanges = watch;
    options.languageServerSettings.watchForConfigChanges = watch;

    const service = new AnalyzerService('<default>', serviceProvider, {
        console: output,
        hostFactory: () => new FullAccessHost(serviceProvider),
        // Refresh service 2 seconds after the last library file change is detected.
        libraryReanalysisTimeProvider: () => 2 * 1000,
    });

    if ('threads' in args) {
        let threadCount = args['threads'];

        // If the thread count was unspecified, use the number of
        // logical CPUs (i.e. hardware threads). We find empirically
        // that going below 4 threads usually doesn't help.
        if (threadCount === null) {
            threadCount = os.cpus().length;
            if (threadCount < 4) {
                threadCount = 1;
            }
        }

        if (threadCount > 1) {
            return runMultiThreaded(args, options, threadCount, service, minSeverityLevel, output);
        }
    }

    return runSingleThreaded(args, options, service, minSeverityLevel, output);
}

const outputResults = (
    args: CommandLineOptions,
    options: PyrightCommandLineOptions,
    results: Pick<AnalysisResults, 'filesInProgram' | 'elapsedTime' | 'diagnostics'>,
    service: AnalyzerService,
    minSeverityLevel: SeverityLevel,
    output: ConsoleInterface
) => {
    const baselineFile = service.backgroundAnalysisProgram.program.baselineHandler;
    const baselineDiffMessage = baselineFile.write(args.writebaseline, true, results.diagnostics)?.getSummaryMessage();
    if (baselineDiffMessage) {
        console.info(baselineDiffMessage);
    }
    // Sort all file diagnostics by the file URI so
    // we have a deterministic ordering.
    const fileDiagnostics = [...results.diagnostics].sort((a, b) =>
        a.fileUri.toString() < b.fileUri.toString() ? -1 : 1
    );
    const filteredDiagnostics = baselineFile.filterOutBaselinedDiagnostics(fileDiagnostics);

    const treatWarningsAsErrors =
        !!args.warnings ||
        filteredDiagnostics.some(
            (fileWithDiagnostics) =>
                fileWithDiagnostics.diagnostics.some(
                    (diagnostic) => diagnostic.category === DiagnosticCategory.Warning
                ) &&
                service.backgroundAnalysisProgram.configOptions.findExecEnvironment(fileWithDiagnostics.fileUri)
                    .diagnosticRuleSet.failOnWarnings
        );
    let errorCount = 0;
    let report: DiagnosticResult;
    if (args.outputjson) {
        report = reportDiagnosticsAsJson(
            filteredDiagnostics,
            minSeverityLevel,
            results.filesInProgram,
            results.elapsedTime
        );
    } else if (process.env['GITHUB_ACTIONS'] && !process.env['PYRIGHT_DISABLE_GITHUB_ACTIONS_OUTPUT']) {
        report = reportDiagnosticsAsGithubActionsCommands(
            filteredDiagnostics,
            minSeverityLevel,
            results.filesInProgram,
            results.elapsedTime
        );
    } else {
        printVersion(output);
        report = reportDiagnosticsAsText(filteredDiagnostics, minSeverityLevel);
    }
    if (args.gitlabcodequality) {
        writeFileSync(
            args.gitlabcodequality,
            JSON.stringify(
                createGitlabCodeQualityReport(
                    filteredDiagnostics,
                    minSeverityLevel,
                    results.filesInProgram,
                    results.elapsedTime
                )
            )
        );
    }
    errorCount += report.errorCount;
    if (treatWarningsAsErrors) {
        errorCount += report.warningCount;
    }
    return errorCount;
};

/**
 * checks for errors parsing config files and / or the baseline file and exits with a non-zero exit code
 * if there were any
 */
const checkForErrors = (exitStatus: Deferred<ExitStatus>, console: ConsoleInterface) => {
    if (console instanceof StandardConsole && console.errorWasLogged) {
        console.errorWasLogged = false;
        exitStatus.resolve(ExitStatus.ConfigFileParseError);
    }
};

async function runSingleThreaded(
    args: CommandLineOptions,
    options: PyrightCommandLineOptions,
    service: AnalyzerService,
    minSeverityLevel: SeverityLevel,
    output: ConsoleInterface
) {
    const watch = args.watch !== undefined;

    const exitStatus = createDeferred<ExitStatus>();

    service.setCompletionCallback((results) => {
        if (results.fatalErrorOccurred) {
            exitStatus.resolve(ExitStatus.FatalError);
            return;
        }

        const errorCount =
            args.createstub || args.verifytypes
                ? 0
                : outputResults(args, options, results, service, minSeverityLevel, output);

        checkForErrors(exitStatus, output);

        if (args.createstub && results.requiringAnalysisCount.files === 0) {
            try {
                service.writeTypeStub(cancellationNone);
                service.dispose();
                console.info(`Type stub was created for '${args.createstub}'`);
            } catch (err) {
                let errMessage = '';
                if (err instanceof Error) {
                    errMessage = err.message;
                }

                console.error(`Error occurred when creating type stub: ${errMessage}`);
                exitStatus.resolve(ExitStatus.FatalError);
                return;
            }
            exitStatus.resolve(ExitStatus.NoErrors);
            return;
        }

        if (!args.outputjson) {
            if (!watch) {
                // Print the total time.
                timingStats.printSummary(output);
            }

            if (args.stats) {
                // Print the stats details.
                service.printStats();
                timingStats.printDetails(console);

                if (args.verbose) {
                    service.printDetailedAnalysisTimes();
                }
            }

            if (args.dependencies) {
                service.printDependencies(!!args.verbose);
            }
        }

        if (!watch) {
            exitStatus.resolve(errorCount > 0 ? ExitStatus.ErrorsReported : ExitStatus.NoErrors);
            return;
        } else if (!args.outputjson) {
            console.info('Watching for file changes...');
        }
    });

    // This will trigger the analyzer.
    service.setOptions(options);

    return await exitStatus.promise;
}

async function runMultiThreaded(
    args: CommandLineOptions,
    options: PyrightCommandLineOptions,
    maxThreadCount: number,
    service: AnalyzerService,
    minSeverityLevel: SeverityLevel,
    output: ConsoleInterface
) {
    const workers: ChildProcess[] = [];
    const startTime = Date.now();
    const exitStatus = createDeferred<ExitStatus>();

    // Specify that only open files should be checked. This will allow us
    // to control which files are checked by which workers.
    options.languageServerSettings.checkOnlyOpenFiles = true;

    // This will trigger discovery of files in the project.
    service.setOptions(options);
    const program = service.backgroundAnalysisProgram.program;

    // Get the list of "tracked" source files -- those that will be type checked.
    const sourceFilesToAnalyze = program.getSourceFileInfoList().filter((info) => info.isTracked);

    // Don't create more workers than there are files.
    const workerCount = Math.min(maxThreadCount, sourceFilesToAnalyze.length);

    // Split the source files into affinity queues, one for each worker. We assume
    // that files that are next to each other in the directory hierarchy probably
    // have more common imports, so we want to analyze them with the same worker
    // if possible to maximize type cache hits.
    const affinityQueues: SourceFileInfo[][] = new Array<SourceFileInfo[]>(workerCount);
    const filesPerAffinityQueue = sourceFilesToAnalyze.length / workerCount;

    for (let i = 0; i < sourceFilesToAnalyze.length; i++) {
        const affinityIndex = Math.floor(i / filesPerAffinityQueue);
        if (affinityQueues[affinityIndex] === undefined) {
            affinityQueues[affinityIndex] = [];
        }

        affinityQueues[affinityIndex].push(sourceFilesToAnalyze[i]);
    }

    output.info(`Found ${sourceFilesToAnalyze.length} files to analyze`);
    output.info(`Using ${workerCount} threads`);

    const fileDiagnostics: FileDiagnostics[] = [];
    let pendingAnalysisCount = 0;

    const sendMessageToWorker = (worker: ChildProcess, message: string, data: any) => {
        worker.send(JSON.stringify({ action: message, data: data }));
    };

    const analyzeNextFile = (workerIndex: number) => {
        const worker = workers[workerIndex];
        let nextFileToAnalyze: SourceFileInfo | undefined;

        // Determine the next file to analyze for this worker.
        for (let i = 0; i < affinityQueues.length; i++) {
            const affinityIndex = (workerIndex + i) % affinityQueues.length;
            if (affinityQueues[affinityIndex].length > 0) {
                nextFileToAnalyze = affinityQueues[affinityIndex].shift()!;
                break;
            }
        }

        if (nextFileToAnalyze) {
            // Tell the worker to analyze the next file.
            const fileUri = nextFileToAnalyze.uri.toString();

            sendMessageToWorker(worker, 'analyzeFile', fileUri);

            pendingAnalysisCount++;
        } else {
            // Kill the worker since there's nothing left to do.
            worker.kill();

            if (pendingAnalysisCount === 0) {
                // If there are no more files to analyze and all pending analysis
                // is complete, report the results and exit.
                if (!exitStatus.resolved) {
                    const elapsedTime = (Date.now() - startTime) / 1000;
                    const errorCount = outputResults(
                        args,
                        options,
                        { diagnostics: fileDiagnostics, filesInProgram: sourceFilesToAnalyze.length, elapsedTime },
                        service,
                        minSeverityLevel,
                        output
                    );
                    if (!args.outputjson) {
                        // Print the total time.
                        output.info(`Completed in ${elapsedTime}sec`);
                    }

                    exitStatus.resolve(errorCount > 0 ? ExitStatus.ErrorsReported : ExitStatus.NoErrors);
                }
            }
        }
    };

    // Launch worker processes.
    for (let i = 0; i < workerCount; i++) {
        const mainModulePath = process.mainModule!.filename;

        // Ensure forked processes use the temp folder owned by the main process.
        // This allows for automatic deletion when the main process exits.
        const worker = fork(mainModulePath, [
            'worker',
            i.toString(),
            service.serviceProvider.get(ServiceKeys.tempFile).tmpdir().getFilePath(),
        ]);

        worker.on('message', (message) => {
            let messageObj: any;

            try {
                messageObj = JSON.parse(message as string);
            } catch {
                output.error(`Invalid message from worker: ${message}`);
                exitStatus.resolve(ExitStatus.FatalError);
            }

            // If the exit status has already been resolved, another thread
            // generated a fatal error, so we shouldn't continue.
            if (exitStatus.resolved) {
                return;
            }

            switch (messageObj.action) {
                case 'analysisResults': {
                    pendingAnalysisCount--;
                    const results = messageObj.data as AnalysisResults;

                    if (results.fatalErrorOccurred) {
                        output.error(`Fatal error from worker`);
                        exitStatus.resolve(ExitStatus.FatalError);
                        return;
                    }

                    for (const fileDiag of results.diagnostics) {
                        fileDiagnostics.push(FileDiagnostics.fromJsonObj(fileDiag));
                    }

                    analyzeNextFile(i);
                    checkForErrors(exitStatus, console);
                    break;
                }

                default: {
                    output.error(`Unknown message from worker: ${message}`);
                    exitStatus.resolve(ExitStatus.FatalError);
                    break;
                }
            }
        });

        worker.on('error', (err) => {
            output.error(`Failed to start child process: ${err}`);
            exitStatus.resolve(ExitStatus.FatalError);
        });

        sendMessageToWorker(worker, 'setOptions', options);
        workers.push(worker);

        // Tell the worker to analyze the next file.
        analyzeNextFile(i);
    }

    return await exitStatus.promise;
}

// This is the message loop for a worker process used used for
// multi-threaded analysis.
function runWorkerMessageLoop(workerNum: number, tempFolderName: string) {
    let serviceProvider: ServiceProvider | undefined;
    let service: AnalyzerService | undefined;
    let fileSystem: PyrightFileSystem | undefined;
    let lastOpenFileUri: Uri | undefined;

    const sendMessageToParent = (message: string, data: any) => {
        process.send?.(JSON.stringify({ action: message, data: data }));
    };

    process.on('message', (message) => {
        let messageObj: any;

        try {
            messageObj = JSON.parse(message as string);
        } catch {
            console.error(`Invalid message from parent: ${message}`);
            return;
        }

        switch (messageObj.action) {
            case 'setOptions': {
                const options = new PyrightCommandLineOptions(process.cwd(), false);

                Object.keys(messageObj.data).forEach((key) => {
                    (options as any)[key] = messageObj.data[key];
                });

                let logLevel = LogLevel.Error;
                if (options.configSettings.verboseOutput) {
                    logLevel = LogLevel.Info;
                }

                const output = new StderrConsole(logLevel);
                const tempFile = new RealTempFile(tempFolderName);
                fileSystem = new PyrightFileSystem(
                    createFromRealFileSystem(tempFile, output, new ChokidarFileWatcherProvider(output))
                );

                serviceProvider = createServiceProvider(fileSystem, output, tempFile);
                service = new AnalyzerService('<default>', serviceProvider, {
                    console: output,
                    hostFactory: () => new FullAccessHost(serviceProvider!),
                    // Refresh service 2 seconds after the last library file change is detected.
                    libraryReanalysisTimeProvider: () => 2 * 1000,
                });

                service.setCompletionCallback((results) => {
                    // We're interested only in diagnostics for the last open file.
                    const fileDiags = results.diagnostics.filter((fileDiag) =>
                        fileDiag.fileUri.equals(lastOpenFileUri)
                    );

                    // Convert JSON-compatible format.
                    const resultsObj = {
                        ...results,
                        diagnostics: fileDiags.map((fileDiag) => FileDiagnostics.toJsonObj(fileDiag)),
                    };

                    sendMessageToParent('analysisResults', resultsObj);
                });

                service.setOptions(options);
                break;
            }

            case 'analyzeFile': {
                if (serviceProvider && fileSystem && service) {
                    const uri = Uri.parse(messageObj.data as string, serviceProvider);

                    // Check the file's length before attempting to read its full contents.
                    const fileStat = fileSystem.statSync(uri);
                    if (fileStat.size > maxSourceFileSize) {
                        console.error(
                            `File length of "${uri}" is ${fileStat.size} ` +
                                `which exceeds the maximum supported file size of ${maxSourceFileSize}`
                        );
                        throw new Error('File larger than max');
                    }

                    const fileContents = fileSystem.readFileSync(uri, 'utf8');

                    lastOpenFileUri = uri;
                    service?.setFileOpened(uri, /* version */ 1, fileContents);
                }
                break;
            }
        }
    });
}

function verifyPackageTypes(
    serviceProvider: ServiceProvider,
    packageName: string,
    options: PyrightCommandLineOptions,
    outputJson: boolean,
    minSeverityLevel: SeverityLevel,
    ignoreUnknownTypesFromImports: boolean
): ExitStatus {
    try {
        const host = new FullAccessHost(serviceProvider);
        const verifier = new PackageTypeVerifier(
            serviceProvider,
            host,
            options,
            packageName,
            ignoreUnknownTypesFromImports
        );
        const report = verifier.verify();
        const jsonReport = buildTypeCompletenessReport(packageName, report, minSeverityLevel);

        if (outputJson) {
            console.info(JSON.stringify(jsonReport, /* replacer */ undefined, 4));
        } else {
            printTypeCompletenessReportText(jsonReport, !!options.configSettings.verboseOutput);
        }

        return jsonReport.typeCompleteness!.completenessScore < 1 ? ExitStatus.ErrorsReported : ExitStatus.NoErrors;
    } catch (err) {
        let errMessage = '';
        if (err instanceof Error) {
            errMessage = ': ' + err.message;
        }

        console.error(`Error occurred when verifying types: ` + errMessage);
        return ExitStatus.FatalError;
    }
}

function accumulateReportDiagnosticStats(diag: PyrightJsonDiagnostic, report: PyrightJsonResults) {
    if (diag.severity === 'error') {
        report.summary.errorCount++;
    } else if (diag.severity === 'warning') {
        report.summary.warningCount++;
    } else if (diag.severity === 'information') {
        report.summary.informationCount++;
    }
}

function buildTypeCompletenessReport(
    packageName: string,
    completenessReport: PackageTypeReport,
    minSeverityLevel: SeverityLevel
): PyrightJsonResults {
    const report: PyrightJsonResults = {
        version,
        time: Date.now().toString(),
        generalDiagnostics: [],
        summary: {
            filesAnalyzed: completenessReport.modules.size,
            errorCount: 0,
            warningCount: 0,
            informationCount: 0,
            timeInSec: timingStats.getTotalDuration(),
        },
    };

    // Add the general diagnostics.
    completenessReport.generalDiagnostics.forEach((diag) => {
        const jsonDiag = convertDiagnosticToJson(undefined, undefined, diag);
        if (isDiagnosticIncluded(jsonDiag.severity, minSeverityLevel)) {
            report.generalDiagnostics.push(jsonDiag);
        }
        accumulateReportDiagnosticStats(jsonDiag, report);
    });

    report.typeCompleteness = {
        packageName,
        packageRootDirectory: completenessReport.packageRootDirectoryUri?.getFilePath(),
        moduleName: completenessReport.moduleName,
        moduleRootDirectory: completenessReport.moduleRootDirectoryUri?.getFilePath(),
        ignoreUnknownTypesFromImports: completenessReport.ignoreExternal,
        pyTypedPath: completenessReport.pyTypedPathUri?.getFilePath(),
        exportedSymbolCounts: {
            withKnownType: 0,
            withAmbiguousType: 0,
            withUnknownType: 0,
        },
        otherSymbolCounts: {
            withKnownType: 0,
            withAmbiguousType: 0,
            withUnknownType: 0,
        },
        missingFunctionDocStringCount: completenessReport.missingFunctionDocStringCount,
        missingClassDocStringCount: completenessReport.missingClassDocStringCount,
        missingDefaultParamCount: completenessReport.missingDefaultParamCount,
        completenessScore: 0,
        modules: [],
        symbols: [],
    };

    // Add the modules.
    completenessReport.modules.forEach((module) => {
        const jsonModule: PyrightPublicModuleReport = {
            name: module.name,
        };

        report.typeCompleteness!.modules.push(jsonModule);
    });

    // Add the symbols.
    completenessReport.symbols.forEach((symbol) => {
        const diagnostics: PyrightJsonDiagnostic[] = [];

        // Convert and filter the diagnostics.
        symbol.diagnostics.forEach((diag) => {
            const jsonDiag = convertDiagnosticToJson(diag.uri, diag.cell, diag.diagnostic);
            if (isDiagnosticIncluded(jsonDiag.severity, minSeverityLevel)) {
                diagnostics.push(jsonDiag);
            }
        });

        const jsonSymbol: PyrightPublicSymbolReport = {
            category: PackageTypeVerifier.getSymbolCategoryString(symbol.category),
            name: symbol.fullName,
            referenceCount: symbol.referenceCount,
            isExported: symbol.isExported,
            isTypeKnown: symbol.typeKnownStatus === TypeKnownStatus.Known,
            isTypeAmbiguous: symbol.typeKnownStatus === TypeKnownStatus.Ambiguous,
            diagnostics,
        };

        const alternateNames = completenessReport.alternateSymbolNames.get(symbol.fullName);
        if (alternateNames) {
            jsonSymbol.alternateNames = alternateNames;
        }

        report.typeCompleteness!.symbols.push(jsonSymbol);

        // Accumulate counts for report.
        if (symbol.typeKnownStatus === TypeKnownStatus.Known) {
            if (symbol.isExported) {
                report.typeCompleteness!.exportedSymbolCounts.withKnownType++;
            } else {
                report.typeCompleteness!.otherSymbolCounts.withKnownType++;
            }
        } else if (symbol.typeKnownStatus === TypeKnownStatus.Ambiguous) {
            if (symbol.isExported) {
                report.typeCompleteness!.exportedSymbolCounts.withAmbiguousType++;
            } else {
                report.typeCompleteness!.otherSymbolCounts.withAmbiguousType++;
            }
        } else {
            if (symbol.isExported) {
                report.typeCompleteness!.exportedSymbolCounts.withUnknownType++;
            } else {
                report.typeCompleteness!.otherSymbolCounts.withUnknownType++;
            }
        }
    });

    const unknownSymbolCount = report.typeCompleteness.exportedSymbolCounts.withUnknownType;
    const ambiguousSymbolCount = report.typeCompleteness.exportedSymbolCounts.withAmbiguousType;
    const knownSymbolCount = report.typeCompleteness.exportedSymbolCounts.withKnownType;
    const totalSymbolCount = unknownSymbolCount + ambiguousSymbolCount + knownSymbolCount;

    if (totalSymbolCount > 0) {
        report.typeCompleteness!.completenessScore = knownSymbolCount / totalSymbolCount;
    }

    return report;
}

function printTypeCompletenessReportText(results: PyrightJsonResults, verboseOutput: boolean) {
    const completenessReport = results.typeCompleteness!;

    console.info(`Module name: "${completenessReport.moduleName}"`);
    if (completenessReport.packageRootDirectory !== undefined) {
        console.info(`Package directory: "${completenessReport.packageRootDirectory}"`);
    }
    if (completenessReport.moduleRootDirectory !== undefined) {
        console.info(`Module directory: "${completenessReport.moduleRootDirectory}"`);
    }

    if (completenessReport.pyTypedPath !== undefined) {
        console.info(`Path of py.typed file: "${completenessReport.pyTypedPath}"`);
    }

    // Print list of public modules.
    if (completenessReport.modules.length > 0) {
        console.info('');
        console.info(`Public modules: ${completenessReport.modules.length}`);
        completenessReport.modules.forEach((module) => {
            console.info(`   ${module.name}`);
        });
    }

    // Print list of all symbols.
    if (completenessReport.symbols.length > 0 && verboseOutput) {
        console.info('');
        console.info(`Exported symbols: ${completenessReport.symbols.filter((sym) => sym.isExported).length}`);
        completenessReport.symbols.forEach((symbol) => {
            if (symbol.isExported) {
                const refCount = symbol.referenceCount > 1 ? ` (${symbol.referenceCount} references)` : '';
                console.info(`   ${symbol.name}${refCount}`);
            }
        });

        console.info('');
        console.info(`Other referenced symbols: ${completenessReport.symbols.filter((sym) => !sym.isExported).length}`);
        completenessReport.symbols.forEach((symbol) => {
            if (!symbol.isExported) {
                const refCount = symbol.referenceCount > 1 ? ` (${symbol.referenceCount} references)` : '';
                console.info(`   ${symbol.name}${refCount}`);
            }
        });
    }

    // Print all the general diagnostics.
    results.generalDiagnostics.forEach((diag) => {
        logDiagnosticToConsole(diag);
    });

    // Print all the symbol-specific diagnostics.
    console.info('');
    console.info(`Symbols used in public interface:`);
    results.typeCompleteness!.symbols.forEach((symbol) => {
        let diagnostics = symbol.diagnostics;
        if (!verboseOutput) {
            diagnostics = diagnostics.filter((diag) => diag.severity === 'error');
        }
        if (diagnostics.length > 0) {
            console.info(`${symbol.name}`);
            diagnostics.forEach((diag) => {
                logDiagnosticToConsole(diag);
            });
        }
    });

    // Print other stats.
    console.info('');
    console.info(
        `Symbols exported by "${completenessReport.packageName}": ${
            completenessReport.exportedSymbolCounts.withKnownType +
            completenessReport.exportedSymbolCounts.withAmbiguousType +
            completenessReport.exportedSymbolCounts.withUnknownType
        }`
    );
    console.info(`  With known type: ${completenessReport.exportedSymbolCounts.withKnownType}`);
    console.info(`  With ambiguous type: ${completenessReport.exportedSymbolCounts.withAmbiguousType}`);
    console.info(`  With unknown type: ${completenessReport.exportedSymbolCounts.withUnknownType}`);
    if (completenessReport.ignoreUnknownTypesFromImports) {
        console.info(`    (Ignoring unknown types imported from other packages)`);
    }
    console.info('');
    console.info(
        `Other symbols referenced but not exported by "${completenessReport.packageName}": ${
            completenessReport.otherSymbolCounts.withKnownType +
            completenessReport.otherSymbolCounts.withAmbiguousType +
            completenessReport.otherSymbolCounts.withUnknownType
        }`
    );
    console.info(`  With known type: ${completenessReport.otherSymbolCounts.withKnownType}`);
    console.info(`  With ambiguous type: ${completenessReport.otherSymbolCounts.withAmbiguousType}`);
    console.info(`  With unknown type: ${completenessReport.otherSymbolCounts.withUnknownType}`);
    console.info('');
    console.info(`Symbols without documentation:`);
    console.info(`  Functions without docstring: ${completenessReport.missingFunctionDocStringCount}`);
    console.info(`  Functions without default param: ${completenessReport.missingDefaultParamCount}`);
    console.info(`  Classes without docstring: ${completenessReport.missingClassDocStringCount}`);
    console.info('');
    console.info(`Type completeness score: ${Math.round(completenessReport.completenessScore * 1000) / 10}%`);
    console.info('');
    console.info(`Completed in ${results.summary.timeInSec}sec`);
    console.info('');
}

function printUsage() {
    console.info(
        'Usage: ' +
            toolName +
            ' [options] files...\n' +
            '  Options:\n' +
            '  --createstub <IMPORT>              Create type stub file(s) for import\n' +
            '  --dependencies                     Emit import dependency information\n' +
            '  -h,--help                          Show this help message\n' +
            '  --ignoreexternal                   Ignore external imports for --verifytypes\n' +
            '  --level <LEVEL>                    Minimum diagnostic level (error or warning)\n' +
            '  --outputjson                       Output results in JSON format\n' +
            '  --gitlabcodequality <FILE>         Output results to a gitlab code quality report\n' +
            '  --writebaseline                    Write new errors to the baseline file\n' +
            '  --baselinefile <FILE>              Path to the baseline file to be used\n' +
            '  -p,--project <FILE OR DIRECTORY>   Use the configuration file at this location\n' +
            '  --pythonplatform <PLATFORM>        Analyze for a specific platform (Darwin, Linux, Windows)\n' +
            '  --pythonpath <FILE>                Path to the Python interpreter\n' +
            '  --pythonversion <VERSION>          Analyze for a specific version (3.3, 3.4, etc.)\n' +
            '  --skipunannotated                  Skip analysis of functions with no type annotations\n' +
            '  --stats                            Print detailed performance stats\n' +
            '  -t,--typeshedpath <DIRECTORY>      Use typeshed type stubs at this location\n' +
            '  --threads <optional COUNT>         Use separate threads to parallelize type checking \n' +
            '  -v,--venvpath <DIRECTORY>          Directory that contains virtual environments\n' +
            '  --verbose                          Emit verbose diagnostics\n' +
            '  --verifytypes <PACKAGE>            Verify type completeness of a py.typed package\n' +
            '  --version                          Print Pyright version and exit\n' +
            '  --warnings                         Use exit code of 1 if warnings are reported\n' +
            '  -w,--watch                         Continue to run and watch for changes\n' +
            '  -                                  Read files from stdin\n'
    );
}

function printVersion(console: ConsoleInterface) {
    console.info(`${toolName} ${version}`);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    console.info(`based on pyright ${require('../package.json').version}`);
}

function reportDiagnosticsAsJsonWithoutLogging(
    fileDiagnostics: readonly FileDiagnostics[],
    minSeverityLevel: SeverityLevel,
    filesInProgram: number,
    timeInSec: number
): PyrightJsonResults {
    const report: PyrightJsonResults = {
        version,
        time: Date.now().toString(),
        generalDiagnostics: [],
        summary: {
            filesAnalyzed: filesInProgram,
            errorCount: 0,
            warningCount: 0,
            informationCount: 0,
            timeInSec,
        },
    };

    fileDiagnostics.forEach((fileDiag) => {
        fileDiag.diagnostics.forEach((diag) => {
            if (
                diag.category === DiagnosticCategory.Error ||
                diag.category === DiagnosticCategory.Warning ||
                diag.category === DiagnosticCategory.Information
            ) {
                const jsonDiag = convertDiagnosticToJson(fileDiag.fileUri, fileDiag.cell, diag);
                if (isDiagnosticIncluded(jsonDiag.severity, minSeverityLevel)) {
                    report.generalDiagnostics.push(jsonDiag);
                }

                accumulateReportDiagnosticStats(jsonDiag, report);
            }
        });
    });

    return report;
}

const pyrightJsonResultsToDiagnosticResult = (report: PyrightJsonResults): DiagnosticResult => ({
    errorCount: report.summary.errorCount,
    warningCount: report.summary.warningCount,
    informationCount: report.summary.informationCount,
    diagnosticCount: report.summary.errorCount + report.summary.warningCount + report.summary.informationCount,
});

const reportDiagnosticsAsJson = (
    fileDiagnostics: readonly FileDiagnostics[],
    minSeverityLevel: SeverityLevel,
    filesInProgram: number,
    timeInSec: number
): DiagnosticResult => {
    const result = reportDiagnosticsAsJsonWithoutLogging(fileDiagnostics, minSeverityLevel, filesInProgram, timeInSec);

    // Output a blank line to help tools that are attempting to parse the
    // JSON output when used in watch mode.
    console.info('');

    console.info(JSON.stringify(result, /* replacer */ undefined, 4));
    return pyrightJsonResultsToDiagnosticResult(result);
};

function isDiagnosticIncluded(diagSeverity: SeverityLevel, minSeverityLevel: SeverityLevel) {
    // Errors are always included.
    if (diagSeverity === 'error') {
        return true;
    }

    // Warnings are included only if the min severity level is below error.
    if (diagSeverity === 'warning') {
        return minSeverityLevel !== 'error';
    }

    // Informations are included only if the min severity level is 'information'.
    return minSeverityLevel === 'information';
}

function convertDiagnosticCategoryToSeverity(category: DiagnosticCategory): SeverityLevel {
    switch (category) {
        case DiagnosticCategory.Error:
            return 'error';

        case DiagnosticCategory.Warning:
            return 'warning';

        case DiagnosticCategory.Information:
            return 'information';

        default:
            fail('Unexpected diagnostic category');
    }
}

function convertDiagnosticToJson(
    fileUri: Uri | undefined,
    cell: number | undefined,
    diag: Diagnostic
): PyrightJsonDiagnostic {
    return {
        file: fileUri?.getFilePath() ?? '',
        cell,
        severity: convertDiagnosticCategoryToSeverity(diag.category),
        message: diag.message,
        range: isEmptyRange(diag.range) ? undefined : diag.range,
        rule: diag.getRule(),
    };
}

const printDiagnosticSummary = (result: DiagnosticResult) => {
    console.info(
        [
            pluralize(result.errorCount, 'error'),
            pluralize(result.warningCount, 'warning'),
            // we use the word "notes" instead because "informations" sounds dumb
            pluralize(result.informationCount, 'note'),
        ].join(', ')
    );
};

function reportDiagnosticsAsText(
    fileDiagnostics: readonly FileDiagnostics[],
    minSeverityLevel: SeverityLevel
): DiagnosticResult {
    let errorCount = 0;
    let warningCount = 0;
    let informationCount = 0;

    fileDiagnostics.forEach((fileDiagnostics) => {
        // Don't report unused code or deprecated diagnostics.
        const fileErrorsAndWarnings = fileDiagnostics.diagnostics.filter(
            (diag) =>
                diag.category !== DiagnosticCategory.Hint &&
                isDiagnosticIncluded(convertDiagnosticCategoryToSeverity(diag.category), minSeverityLevel)
        );

        if (fileErrorsAndWarnings.length > 0) {
            fileErrorsAndWarnings.forEach((diag, index) => {
                const jsonDiag = convertDiagnosticToJson(fileDiagnostics.fileUri, fileDiagnostics.cell, diag);
                if (index === 0) {
                    // only log this once per file. this is only in the for loop because we need to get the cell index from one of the diagnostics
                    console.info(
                        fileDiagnostics.fileUri.toUserVisibleString() +
                            (jsonDiag.cell === undefined ? '' : ` - cell ${jsonDiag.cell + 1}`)
                    );
                }
                logDiagnosticToConsole(jsonDiag);

                if (diag.category === DiagnosticCategory.Error) {
                    errorCount++;
                } else if (diag.category === DiagnosticCategory.Warning) {
                    warningCount++;
                } else if (diag.category === DiagnosticCategory.Information) {
                    informationCount++;
                }
            });
        }
    });

    const result = {
        errorCount,
        warningCount,
        informationCount,
        diagnosticCount: errorCount + warningCount + informationCount,
    };
    printDiagnosticSummary(result);
    return result;
}

/**
 * copied from {@link https://github.com/jakebailey/pyright-action}, where it says it was copied from here,
 * but it seems to have been heavily modified so i'm copying it back
 */
const diagnosticToString = (diagnostic: PyrightJsonDiagnostic, forCommand: boolean): string => {
    let message = '';
    if (!forCommand) {
        if (diagnostic.file) {
            message += `${diagnostic.file}:`;
        }
        if (diagnostic.range && !isEmptyRange(diagnostic.range)) {
            message += `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} -`;
        }
        message += ` ${diagnostic.severity}: `;
    }

    message += diagnostic.message;

    if (diagnostic.rule) {
        message += ` (${diagnostic.rule})`;
    }

    return message;
};

/**
 * if it's a notebook we have no easy way to figure out what line the diagnostic is on in the raw json,
 * so we just put them all on the first line
 */
const convertDiagnosticsForCiOutput = (generalDiagnostics: readonly PyrightJsonDiagnostic[]): PyrightJsonDiagnostic[] =>
    generalDiagnostics.map((diagnostic) => {
        if (diagnostic.cell === undefined) {
            return diagnostic;
        } else {
            const position: Position = { line: 0, character: 0 };
            return { ...diagnostic, range: { start: position, end: position } };
        }
    });

const reportDiagnosticsAsGithubActionsCommands = (
    fileDiagnostics: readonly FileDiagnostics[],
    minSeverityLevel: SeverityLevel,
    filesInProgram: number,
    timeInSec: number
): DiagnosticResult => {
    const report = reportDiagnosticsAsJsonWithoutLogging(fileDiagnostics, minSeverityLevel, filesInProgram, timeInSec);
    for (const diagnostic of convertDiagnosticsForCiOutput(report.generalDiagnostics)) {
        core.info(diagnosticToString(diagnostic, /* forCommand */ false));

        if (!isDiagnosticIncluded(diagnostic.severity, minSeverityLevel)) {
            continue;
        }

        if (diagnostic.severity === 'information') {
            continue;
        }

        const line = diagnostic.range?.start.line ?? 0;
        const col = diagnostic.range?.start.character ?? 0;
        const message = diagnosticToString(diagnostic, /* forCommand */ true);

        // This is technically a log line and duplicates the core.info above,
        // but we want to have the below look nice in commit comments.
        command.issueCommand(
            diagnostic.severity,
            {
                file: diagnostic.file,
                line: line + 1,
                col: col + 1,
            },
            message
        );
    }

    const result = pyrightJsonResultsToDiagnosticResult(report);
    if (result.errorCount !== 0) {
        core.setFailed(pluralize(result.errorCount, 'error', 'errors'));
    }
    printDiagnosticSummary(result);
    return result;
};

const createGitlabCodeQualityReport = (
    fileDiagnostics: readonly FileDiagnostics[],
    minSeverityLevel: SeverityLevel,
    filesInProgram: number,
    timeInSec: number
) => {
    const report = reportDiagnosticsAsJsonWithoutLogging(fileDiagnostics, minSeverityLevel, filesInProgram, timeInSec);
    return convertDiagnostics(convertDiagnosticsForCiOutput(report.generalDiagnostics), path.resolve('.'));
};

function logDiagnosticToConsole(diag: PyrightJsonDiagnostic, prefix = '  ') {
    let message = prefix;
    if (diag.file) {
        message += `${diag.file}:`;
    }
    if (diag.cell !== undefined) {
        message += chalk.yellow(`${diag.cell + 1}`) + ':';
    }
    if (diag.range && !isEmptyRange(diag.range)) {
        message +=
            chalk.yellow(`${diag.range.start.line + 1}`) +
            ':' +
            chalk.yellow(`${diag.range.start.character + 1}`) +
            ' - ';
    } else {
        message += ' ';
    }

    const [firstLine, ...remainingLines] = diag.message.split('\n');

    message +=
        diag.severity === 'error'
            ? chalk.red('error')
            : diag.severity === 'warning'
            ? chalk.cyan('warning')
            : chalk.blue('information');
    message += `: ${firstLine}`;
    if (remainingLines.length > 0) {
        message += '\n' + prefix + remainingLines.join('\n' + prefix);
    }

    if (diag.rule) {
        message += chalk.gray(` (${diag.rule})`);
    }

    console.info(message);
}

function parseThreadsArgValue(input: string | null): any {
    if (input === null || input === 'auto') {
        return null;
    }

    const value = parseInt(input, 10);
    if (isNaN(value) || value < 1) {
        throw new Error(`'${input}' is not a valid value for --threads; specify a positive integer or 'auto'`);
    }

    return value;
}

// Increase the default stack trace limit from 16 to 64 to help diagnose
// crashes with deep stack traces.
Error.stackTraceLimit = 64;

export async function main() {
    await initializeDependencies();

    // Is this a worker process for multi-threaded analysis?
    if (process.argv[2] === 'worker') {
        const workerNumber = parseInt(process.argv[3]);
        runWorkerMessageLoop(workerNumber, process.argv[4]);
        return;
    }

    const exitCode = await processArgs();
    process.exitCode = exitCode;
    // Don't call process.exit; stdout may not have been flushed which can break readers.
    // https://github.com/nodejs/node/issues/6379
    // https://github.com/nodejs/node/issues/6456
    // https://github.com/nodejs/node/issues/19218
}
