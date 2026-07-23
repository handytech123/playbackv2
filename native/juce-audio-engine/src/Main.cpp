#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_audio_utils/juce_audio_utils.h>
#include <juce_core/juce_core.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <iostream>
#include <memory>
#include <utility>
#include <vector>

namespace
{
constexpr int protocolVersion = 1;
constexpr double toneFrequencyHz = 880.0;
constexpr int defaultRequestedOutputs = 2;

void writeJsonLine(const juce::var& value)
{
    std::cout << juce::JSON::toString(value, true) << std::endl;
}

juce::DynamicObject::Ptr makeBaseResponse(const juce::String& type, const juce::String& requestId)
{
    juce::DynamicObject::Ptr response = new juce::DynamicObject();
    response->setProperty("type", type);
    response->setProperty("requestId", requestId);
    response->setProperty("protocolVersion", protocolVersion);
    response->setProperty("engine", "juce-audio-engine");
    return response;
}

juce::String getRequestId(const juce::DynamicObject* object)
{
    if (object == nullptr)
        return {};

    return object->getProperty("requestId").toString();
}

int requestedOutputCountForDevice(const juce::String& deviceName, int requiredOutputs = defaultRequestedOutputs)
{
    juce::ignoreUnused(deviceName);
    return juce::jmax(defaultRequestedOutputs, requiredOutputs);
}

void selectDeviceType(juce::AudioDeviceManager& manager, const juce::String& deviceType)
{
    if (deviceType.isNotEmpty())
        manager.setCurrentAudioDeviceType(deviceType, true);
}

void configureOutputChannels(juce::AudioDeviceManager::AudioDeviceSetup& setup, int requestedOutputs)
{
    setup.useDefaultInputChannels = false;
    setup.useDefaultOutputChannels = false;
    setup.outputChannels.clear();
    setup.outputChannels.setRange(0, juce::jmax(1, requestedOutputs), true);
}

juce::String openManagedDevice(juce::AudioDeviceManager& manager,
                               juce::AudioDeviceManager::AudioDeviceSetup& setup,
                               const juce::String& deviceType,
                               int requestedOutputs)
{
    auto error = manager.initialise(0, requestedOutputs, nullptr, false);

    if (error.isNotEmpty())
        return error;

    selectDeviceType(manager, deviceType);
    return manager.setAudioDeviceSetup(setup, true);
}

int maxOutputChannelFromStemRoutes(const juce::Array<juce::var>* stems)
{
    int maxChannel = defaultRequestedOutputs;

    if (stems == nullptr)
        return maxChannel;

    for (auto& stemValue : *stems)
    {
        auto* stem = stemValue.getDynamicObject();

        if (stem == nullptr)
            continue;

        for (const auto& routeName : { juce::Identifier("routing"), juce::Identifier("iemRouting") })
        {
            auto* routing = stem->getProperty(routeName).getDynamicObject();
            auto* outputChannels = routing != nullptr ? routing->getProperty("outputChannels").getArray() : nullptr;

            if (outputChannels == nullptr)
                continue;

            for (auto& channel : *outputChannels)
                maxChannel = juce::jmax(maxChannel, static_cast<int>(channel));
        }
    }

    return maxChannel;
}

void sendRejected(const juce::String& requestId, const juce::String& reason)
{
    auto response = makeBaseResponse("commandRejected", requestId);
    response->setProperty("reason", reason);
    writeJsonLine(juce::var(response.get()));
}

void sendReady(const juce::String& requestId)
{
    auto response = makeBaseResponse("ready", requestId);
    response->setProperty("nativeAudioActive", true);
    response->setProperty("message", "JUCE helper is running.");
    writeJsonLine(juce::var(response.get()));
}

class ToneCallback final : public juce::AudioIODeviceCallback
{
public:
    explicit ToneCallback(int durationMsToPlay)
        : durationMs(durationMsToPlay)
    {
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override
    {
        sampleRate = device != nullptr ? device->getCurrentSampleRate() : 48000.0;
        phase = 0.0;
        totalSamples = static_cast<int64_t>((sampleRate * durationMs) / 1000.0);
        samplesWritten.store(0);
        finished.store(false);
    }

    void audioDeviceStopped() override
    {
        finished.store(true);
    }

    void audioDeviceIOCallbackWithContext(const float* const*,
                                          int,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext&) override
    {
        auto writtenAtStart = samplesWritten.load();
        auto phaseDelta = juce::MathConstants<double>::twoPi * toneFrequencyHz / sampleRate;

        for (int sample = 0; sample < numSamples; ++sample)
        {
            const auto globalSample = writtenAtStart + sample;
            auto level = 0.0f;

            if (globalSample < totalSamples)
            {
                const auto fadeSamples = static_cast<int64_t>(sampleRate * 0.03);
                const auto fadeIn = juce::jlimit(0.0, 1.0, static_cast<double>(globalSample) / static_cast<double>(fadeSamples));
                const auto fadeOut = juce::jlimit(0.0, 1.0, static_cast<double>(totalSamples - globalSample) / static_cast<double>(fadeSamples));
                level = static_cast<float>(std::sin(phase) * 0.15 * juce::jmin(fadeIn, fadeOut));
                phase += phaseDelta;

                if (phase >= juce::MathConstants<double>::twoPi)
                    phase -= juce::MathConstants<double>::twoPi;
            }

            for (int channel = 0; channel < numOutputChannels; ++channel)
                if (outputChannelData[channel] != nullptr)
                    outputChannelData[channel][sample] = level;
        }

        const auto newCount = samplesWritten.fetch_add(numSamples) + numSamples;

        if (newCount >= totalSamples)
            finished.store(true);
    }

    bool hasFinished() const
    {
        return finished.load();
    }

private:
    int durationMs = 1000;
    double sampleRate = 48000.0;
    double phase = 0.0;
    int64_t totalSamples = 0;
    std::atomic<int64_t> samplesWritten { 0 };
    std::atomic<bool> finished { false };
};

juce::Array<juce::AudioDeviceManager::AudioDeviceSetup> getDeviceSetups()
{
    juce::Array<juce::AudioDeviceManager::AudioDeviceSetup> setups;
    return setups;
}

void sendDevices(const juce::String& requestId)
{
    auto response = makeBaseResponse("devices", requestId);
    juce::Array<juce::var> devices;
    juce::AudioDeviceManager manager;
    juce::OwnedArray<juce::AudioIODeviceType> types;

    manager.createAudioDeviceTypes(types);

    for (auto* type : types)
    {
        if (type == nullptr)
            continue;

        type->scanForDevices();
        const auto outputNames = type->getDeviceNames(false);

        for (const auto& name : outputNames)
        {
            juce::DynamicObject::Ptr device = new juce::DynamicObject();
            device->setProperty("id", type->getTypeName() + ":" + name);
            device->setProperty("name", name);
            device->setProperty("type", type->getTypeName());
            device->setProperty("isOutput", true);
            devices.add(juce::var(device.get()));
        }
    }

    response->setProperty("nativeAudioActive", true);
    response->setProperty("devices", devices);
    writeJsonLine(juce::var(response.get()));
}

void sendDeviceProbe(const juce::String& requestId,
                     const juce::String& deviceName,
                     const juce::String& deviceType,
                     int requestedOutputs)
{
    juce::AudioDeviceManager manager;
    juce::OwnedArray<juce::AudioIODeviceType> types;
    manager.createAudioDeviceTypes(types);

    for (auto* type : types)
    {
        if (type == nullptr || type->getTypeName() != deviceType)
            continue;

        type->scanForDevices();
        std::unique_ptr<juce::AudioIODevice> device(type->createDevice(deviceName, {}));

        if (device == nullptr)
        {
            sendRejected(requestId, "JUCE could not create the requested device.");
            return;
        }

        juce::BigInteger outputs;
        outputs.setRange(0, requestedOutputs, true);
        juce::BigInteger inputs;
        const auto sampleRates = device->getAvailableSampleRates();
        const auto bufferSizes = device->getAvailableBufferSizes();
        const auto sampleRate = sampleRates.contains(48000.0) ? 48000.0 : (sampleRates.isEmpty() ? 0.0 : sampleRates[0]);
        const auto bufferSize = bufferSizes.contains(256) ? 256 : (bufferSizes.contains(480) ? 480 : (bufferSizes.isEmpty() ? 0 : bufferSizes[0]));
        const auto error = device->open(inputs, outputs, sampleRate, bufferSize);

        if (error.isNotEmpty())
        {
            sendRejected(requestId, "Direct device open failed: " + error);
            return;
        }

        juce::Array<juce::var> outputNames;
        for (const auto& name : device->getOutputChannelNames())
            outputNames.add(name);

        auto response = makeBaseResponse("deviceProbe", requestId);
        response->setProperty("nativeAudioActive", true);
        response->setProperty("deviceName", device->getName());
        response->setProperty("deviceType", deviceType);
        response->setProperty("requestedOutputChannels", requestedOutputs);
        response->setProperty("outputChannels", device->getActiveOutputChannels().countNumberOfSetBits());
        response->setProperty("availableOutputChannels", outputNames.size());
        response->setProperty("outputChannelNames", outputNames);
        response->setProperty("sampleRate", device->getCurrentSampleRate());
        response->setProperty("bufferSize", device->getCurrentBufferSizeSamples());
        device->close();
        writeJsonLine(juce::var(response.get()));
        return;
    }

    sendRejected(requestId, "JUCE device type not found: " + deviceType);
}

void sendToneResult(const juce::String& requestId, const juce::String& deviceName, const juce::String& deviceType, int durationMs)
{
    juce::AudioDeviceManager manager;
    juce::AudioDeviceManager::AudioDeviceSetup setup;
    setup.outputDeviceName = deviceName;
    const auto requestedOutputs = requestedOutputCountForDevice(deviceName);
    configureOutputChannels(setup, requestedOutputs);

    auto error = openManagedDevice(manager, setup, deviceType, requestedOutputs);

    if (error.isNotEmpty())
    {
        sendRejected(requestId, "Audio device open failed: " + error);
        return;
    }

    auto* currentDevice = manager.getCurrentAudioDevice();

    if (currentDevice == nullptr)
    {
        sendRejected(requestId, "Audio device open failed: no current device.");
        return;
    }

    ToneCallback callback(durationMs);
    manager.addAudioCallback(&callback);

    const auto startedAt = juce::Time::getMillisecondCounter();
    const auto timeoutMs = juce::jmax(1000, durationMs + 2000);

    while (! callback.hasFinished())
    {
        juce::Thread::sleep(20);

        if (juce::Time::getMillisecondCounter() - startedAt > static_cast<uint32_t>(timeoutMs))
            break;
    }

    manager.removeAudioCallback(&callback);

    auto response = makeBaseResponse("testToneComplete", requestId);
    response->setProperty("nativeAudioActive", true);
    response->setProperty("deviceName", currentDevice->getName());
    response->setProperty("deviceType", currentDevice->getTypeName());
    response->setProperty("sampleRate", currentDevice->getCurrentSampleRate());
    response->setProperty("bufferSize", currentDevice->getCurrentBufferSizeSamples());
    response->setProperty("requestedOutputChannels", requestedOutputs);
    response->setProperty("outputChannels", currentDevice->getActiveOutputChannels().countNumberOfSetBits());
    response->setProperty("durationMs", durationMs);
    writeJsonLine(juce::var(response.get()));
}

struct StemSource
{
    juce::String id;
    juce::String name;
    std::unique_ptr<juce::AudioFormatReaderSource> readerSource;
    std::unique_ptr<juce::AudioTransportSource> transport;
    juce::Array<int> outputChannels;
    juce::Array<int> iemOutputChannels;
    float baseGain = 1.0f;
    std::atomic<float> peakLevel { 0.0f };
    bool solo = false;
};

struct StemMeterSnapshot
{
    juce::String id;
    juce::String name;
    float level = 0.0f;
};

struct ClickBeat
{
    double timeSeconds = 0.0;
    bool strong = false;
};

struct ClickSample
{
    juce::AudioBuffer<float> buffer;
    double sourceSampleRate = 48000.0;

    bool isReady() const
    {
        return buffer.getNumChannels() > 0 && buffer.getNumSamples() > 0 && sourceSampleRate > 0.0;
    }
};

ClickSample loadClickSample(juce::AudioFormatManager& formatManager, const juce::String& filePath);

struct DynamicCueEvent
{
    juce::String id;
    juce::String name;
    ClickSample sample;
    double triggerTimeSeconds = 0.0;
    double position = -1.0;
    bool triggered = false;
};

juce::Array<int> readOutputChannels(juce::DynamicObject* object, const juce::Array<int>& fallback);
juce::Array<int> readIemOutputChannels(juce::DynamicObject* object);
float gainFromMixerObject(juce::DynamicObject* object);

class RoutedPlaybackSource final : public juce::AudioSource
{
public:
    void setSources(std::vector<std::unique_ptr<StemSource>>* nextSources)
    {
        sources = nextSources;
    }

    void setDynamicClick(double nextBpm,
                         const juce::Array<int>& nextOutputs,
                         float nextGain,
                         std::vector<ClickBeat> nextBeatGrid,
                         ClickSample nextClickSample,
                         ClickSample nextAccentSample)
    {
        bpm = nextBpm > 0.0 ? nextBpm : 120.0;
        clickOutputChannels = nextOutputs;
        clickGain = juce::jlimit(0.0f, 1.0f, nextGain);
        beatGrid = std::move(nextBeatGrid);
        clickSample = std::move(nextClickSample);
        accentSample = std::move(nextAccentSample);
        nextBeatIndex = 0;
        elapsedSamples = 0;
        samplesSinceClick = 0.0;
        beatIndex = 0;
        strongBeat = true;
        clickPosition = -1.0;
        accentPosition = -1.0;
    }

    void setDynamicCues(std::vector<DynamicCueEvent> nextCues, const juce::Array<int>& nextOutputs, float nextGain)
    {
        dynamicCues = std::move(nextCues);
        dynamicCueOutputChannels = nextOutputs;
        dynamicCueGain = juce::jlimit(0.0f, 1.0f, nextGain);
        for (auto& cue : dynamicCues)
        {
            cue.position = -1.0;
            cue.triggered = false;
        }
    }

    void setDynamicPad(const juce::Array<int>& nextOutputs, float nextGain, ClickSample nextSample)
    {
        dynamicPadOutputChannels = nextOutputs;
        dynamicPadGain = juce::jlimit(0.0f, 1.0f, nextGain);
        dynamicPadSample = std::move(nextSample);
        dynamicPadPosition = 0.0;
        dynamicPadActive = false;
    }

    void triggerDynamicCueNow(DynamicCueEvent cue)
    {
        cue.triggered = true;
        cue.position = 0.0;
        dynamicCues.push_back(std::move(cue));
    }

    void updateDynamicMixer(const juce::Array<int>& nextClickOutputs,
                            float nextClickGain,
                            const juce::Array<int>& nextCueOutputs,
                            float nextCueGain,
                            const juce::Array<int>& nextPadOutputs,
                            float nextPadGain,
                            bool nextPadActive)
    {
        clickOutputChannels = nextClickOutputs;
        clickGain = juce::jlimit(0.0f, 1.0f, nextClickGain);
        dynamicCueOutputChannels = nextCueOutputs;
        dynamicCueGain = juce::jlimit(0.0f, 1.0f, nextCueGain);
        dynamicPadOutputChannels = nextPadOutputs;
        dynamicPadGain = juce::jlimit(0.0f, 1.0f, nextPadGain);
        dynamicPadActive = nextPadActive;
        if (! dynamicPadActive)
            dynamicPadPeakLevel.store(0.0f);
    }

    void seekTo(double seconds)
    {
        elapsedSamples = static_cast<int64_t>(juce::jmax(0.0, seconds) * sampleRate);
        samplesSinceClick = 0.0;
        clickPosition = -1.0;
        accentPosition = -1.0;
        nextBeatIndex = 0;

        while (nextBeatIndex < beatGrid.size() && beatGrid[nextBeatIndex].timeSeconds < seconds)
            ++nextBeatIndex;

        for (auto& cue : dynamicCues)
        {
            cue.position = -1.0;
            cue.triggered = cue.triggerTimeSeconds < seconds;
        }
    }

    void setPaused(bool shouldPause)
    {
        paused = shouldPause;
        if (! paused)
            return;

        clickPosition = -1.0;
        accentPosition = -1.0;
        for (auto& cue : dynamicCues)
            cue.position = -1.0;
    }

    void prepareToPlay(int samplesPerBlockExpected, double nextSampleRate) override
    {
        sampleRate = nextSampleRate > 0.0 ? nextSampleRate : 48000.0;
        tempBuffer.setSize(2, samplesPerBlockExpected, false, false, true);
        if (sources != nullptr)
            for (auto& source : *sources)
                source->transport->prepareToPlay(samplesPerBlockExpected, sampleRate);
    }

    void releaseResources() override
    {
        if (sources != nullptr)
            for (auto& source : *sources)
                source->transport->releaseResources();
    }

    void getNextAudioBlock(const juce::AudioSourceChannelInfo& bufferToFill) override
    {
        auto* output = bufferToFill.buffer;
        if (output == nullptr)
            return;

        output->clear(bufferToFill.startSample, bufferToFill.numSamples);

        if (paused)
            return;

        if (sources != nullptr)
        {
            for (auto& source : *sources)
            {
                tempBuffer.setSize(juce::jmax(2, static_cast<int>(source->readerSource->getAudioFormatReader()->numChannels)),
                                   bufferToFill.numSamples,
                                   false,
                                   false,
                                   true);
                tempBuffer.clear();
                juce::AudioSourceChannelInfo tempInfo(&tempBuffer, 0, bufferToFill.numSamples);
                source->transport->getNextAudioBlock(tempInfo);
                auto peak = 0.0f;
                for (int channel = 0; channel < tempBuffer.getNumChannels(); ++channel)
                    peak = juce::jmax(peak, tempBuffer.getMagnitude(channel, 0, bufferToFill.numSamples));
                const auto nextPeak = peak * source->baseGain;
                const auto previousPeak = source->peakLevel.load();
                source->peakLevel.store(juce::jmax(nextPeak, previousPeak * 0.88f));

                for (int outputChannel : source->outputChannels)
                {
                    const auto zeroBasedOutput = outputChannel - 1;
                    if (zeroBasedOutput < 0 || zeroBasedOutput >= output->getNumChannels())
                        continue;

                    const auto sourceChannel = source->outputChannels.size() > 1 && outputChannel == source->outputChannels[1] ? 1 : 0;
                    output->addFrom(zeroBasedOutput,
                                    bufferToFill.startSample,
                                    tempBuffer,
                                    juce::jmin(sourceChannel, tempBuffer.getNumChannels() - 1),
                                    0,
                                    bufferToFill.numSamples);
                }

                for (int outputChannel : source->iemOutputChannels)
                {
                    const auto zeroBasedOutput = outputChannel - 1;
                    if (zeroBasedOutput < 0 || zeroBasedOutput >= output->getNumChannels())
                        continue;

                    const auto sourceChannel = source->iemOutputChannels.size() > 1 && outputChannel == source->iemOutputChannels[1] ? 1 : 0;
                    output->addFrom(zeroBasedOutput,
                                    bufferToFill.startSample,
                                    tempBuffer,
                                    juce::jmin(sourceChannel, tempBuffer.getNumChannels() - 1),
                                    0,
                                    bufferToFill.numSamples);
                }
            }
        }

        addDynamicClick(*output, bufferToFill.startSample, bufferToFill.numSamples);
        addDynamicCues(*output, bufferToFill.startSample, bufferToFill.numSamples);
        addDynamicPad(*output, bufferToFill.startSample, bufferToFill.numSamples);
        elapsedSamples += bufferToFill.numSamples;
    }

    std::vector<StemMeterSnapshot> readStemMeters()
    {
        std::vector<StemMeterSnapshot> meters;
        if (sources == nullptr)
            return meters;

        for (auto& source : *sources)
        {
            StemMeterSnapshot meter;
            meter.id = source->id;
            meter.name = source->name;
            const auto currentPeak = source->peakLevel.load();
            meter.level = juce::jlimit(0.0f, 1.0f, currentPeak);
            source->peakLevel.store(currentPeak * 0.82f);
            meters.push_back(std::move(meter));
        }

        addDynamicMeter(meters, "dynamic-click", "Dynamic Click", dynamicClickPeakLevel);
        addDynamicMeter(meters, "dynamic-cue", "Dynamic Cue", dynamicCuePeakLevel);
        addDynamicMeter(meters, "dynamic-pad", "Dynamic Pad", dynamicPadPeakLevel);
        return meters;
    }

private:
    void addDynamicMeter(std::vector<StemMeterSnapshot>& meters,
                         const juce::String& id,
                         const juce::String& name,
                         std::atomic<float>& level)
    {
        StemMeterSnapshot meter;
        meter.id = id;
        meter.name = name;
        const auto currentPeak = level.load();
        meter.level = juce::jlimit(0.0f, 1.0f, currentPeak);
        level.store(currentPeak * 0.82f);
        meters.push_back(std::move(meter));
    }

    void addDynamicClick(juce::AudioBuffer<float>& output, int startSample, int numSamples)
    {
        if (clickOutputChannels.isEmpty() || bpm <= 0.0 || sampleRate <= 0.0 || (! clickSample.isReady() && ! accentSample.isReady()))
            return;

        const auto samplesPerBeat = sampleRate * 60.0 / bpm;

        if (beatGrid.empty() && elapsedSamples == 0 && samplesSinceClick == 0.0)
            triggerClickSample(true);

        for (int sample = 0; sample < numSamples; ++sample)
        {
            triggerGridClickIfNeeded(sample);
            const auto level = nextClickSampleValue() * clickGain;
            dynamicClickPeakLevel.store(juce::jmax(dynamicClickPeakLevel.load(), std::abs(level)));

            for (int outputChannel : clickOutputChannels)
            {
                const auto zeroBasedOutput = outputChannel - 1;
                if (zeroBasedOutput >= 0 && zeroBasedOutput < output.getNumChannels())
                    output.addSample(zeroBasedOutput, startSample + sample, level);
            }

            samplesSinceClick += 1.0;
            if (beatGrid.empty() && samplesSinceClick >= samplesPerBeat)
            {
                samplesSinceClick -= samplesPerBeat;
                beatIndex = (beatIndex + 1) % 4;
                strongBeat = beatIndex == 0;
                triggerClickSample(strongBeat);
            }
        }
    }

    void addDynamicCues(juce::AudioBuffer<float>& output, int startSample, int numSamples)
    {
        if (dynamicCueOutputChannels.isEmpty() || sampleRate <= 0.0 || dynamicCues.empty())
            return;

        for (int sample = 0; sample < numSamples; ++sample)
        {
            const auto currentTimeSeconds = static_cast<double>(elapsedSamples + sample) / sampleRate;
            float level = 0.0f;

            for (auto& cue : dynamicCues)
            {
                if (! cue.triggered && currentTimeSeconds >= cue.triggerTimeSeconds)
                {
                    cue.triggered = true;
                    cue.position = 0.0;
                }

                level += nextSampleValue(cue.sample, cue.position);
            }

            level *= dynamicCueGain;
            dynamicCuePeakLevel.store(juce::jmax(dynamicCuePeakLevel.load(), std::abs(level)));

            if (level == 0.0f)
                continue;

            for (int outputChannel : dynamicCueOutputChannels)
            {
                const auto zeroBasedOutput = outputChannel - 1;
                if (zeroBasedOutput >= 0 && zeroBasedOutput < output.getNumChannels())
                    output.addSample(zeroBasedOutput, startSample + sample, level);
            }
        }
    }

    void addDynamicPad(juce::AudioBuffer<float>& output, int startSample, int numSamples)
    {
        if (! dynamicPadActive || dynamicPadOutputChannels.isEmpty() || sampleRate <= 0.0 || ! dynamicPadSample.isReady())
            return;

        for (int sample = 0; sample < numSamples; ++sample)
        {
            auto level = nextLoopingSampleValue(dynamicPadSample, dynamicPadPosition) * dynamicPadGain;
            dynamicPadPeakLevel.store(juce::jmax(dynamicPadPeakLevel.load(), std::abs(level)));
            if (level == 0.0f)
                continue;

            for (int outputChannel : dynamicPadOutputChannels)
            {
                const auto zeroBasedOutput = outputChannel - 1;
                if (zeroBasedOutput >= 0 && zeroBasedOutput < output.getNumChannels())
                    output.addSample(zeroBasedOutput, startSample + sample, level);
            }
        }
    }

    void triggerGridClickIfNeeded(int sample)
    {
        if (beatGrid.empty())
            return;

        const auto currentTimeSeconds = static_cast<double>(elapsedSamples + sample) / sampleRate;
        while (nextBeatIndex < beatGrid.size() && currentTimeSeconds >= beatGrid[nextBeatIndex].timeSeconds)
        {
            samplesSinceClick = 0.0;
            strongBeat = beatGrid[nextBeatIndex].strong;
            triggerClickSample(strongBeat);
            ++nextBeatIndex;
        }
    }

    void triggerClickSample(bool accent)
    {
        if (accent && accentSample.isReady())
        {
            accentPosition = 0.0;
            return;
        }

        if (clickSample.isReady())
            clickPosition = 0.0;
    }

    float nextClickSampleValue()
    {
        float value = 0.0f;
        value += nextSampleValue(accentSample, accentPosition);
        value += nextSampleValue(clickSample, clickPosition);
        return value;
    }

    float nextSampleValue(const ClickSample& sample, double& position)
    {
        if (! sample.isReady() || position < 0.0)
            return 0.0f;

        const auto firstIndex = static_cast<int>(position);
        if (firstIndex >= sample.buffer.getNumSamples())
        {
            position = -1.0;
            return 0.0f;
        }

        const auto nextIndex = juce::jmin(firstIndex + 1, sample.buffer.getNumSamples() - 1);
        const auto fraction = static_cast<float>(position - firstIndex);
        const auto first = sample.buffer.getSample(0, firstIndex);
        const auto next = sample.buffer.getSample(0, nextIndex);
        position += sample.sourceSampleRate / sampleRate;

        return first + ((next - first) * fraction);
    }

    float nextLoopingSampleValue(const ClickSample& sample, double& position)
    {
        if (! sample.isReady())
            return 0.0f;

        if (position < 0.0)
            position = 0.0;

        while (position >= sample.buffer.getNumSamples())
            position -= sample.buffer.getNumSamples();

        const auto firstIndex = static_cast<int>(position);
        const auto nextIndex = (firstIndex + 1) % sample.buffer.getNumSamples();
        const auto fraction = static_cast<float>(position - firstIndex);
        const auto first = sample.buffer.getSample(0, firstIndex);
        const auto next = sample.buffer.getSample(0, nextIndex);
        position += sample.sourceSampleRate / sampleRate;

        return first + ((next - first) * fraction);
    }

    std::vector<std::unique_ptr<StemSource>>* sources = nullptr;
    juce::AudioBuffer<float> tempBuffer;
    juce::Array<int> clickOutputChannels;
    juce::Array<int> dynamicCueOutputChannels;
    juce::Array<int> dynamicPadOutputChannels;
    std::vector<ClickBeat> beatGrid;
    std::vector<DynamicCueEvent> dynamicCues;
    ClickSample clickSample;
    ClickSample accentSample;
    ClickSample dynamicPadSample;
    double sampleRate = 48000.0;
    double bpm = 120.0;
    double samplesSinceClick = 0.0;
    double clickPosition = -1.0;
    double accentPosition = -1.0;
    double dynamicPadPosition = 0.0;
    float clickGain = 0.8f;
    float dynamicCueGain = 0.8f;
    float dynamicPadGain = 0.8f;
    std::atomic<float> dynamicClickPeakLevel { 0.0f };
    std::atomic<float> dynamicCuePeakLevel { 0.0f };
    std::atomic<float> dynamicPadPeakLevel { 0.0f };
    int64_t elapsedSamples = 0;
    size_t nextBeatIndex = 0;
    int beatIndex = 0;
    bool strongBeat = true;
    bool paused = false;
    bool dynamicPadActive = false;
};

struct PlaybackSession
{
    juce::AudioDeviceManager manager;
    juce::AudioFormatManager formatManager;
    juce::TimeSliceThread readAheadThread { "stem read ahead" };
    RoutedPlaybackSource routedSource;
    juce::AudioSourcePlayer sourcePlayer;
    std::vector<std::unique_ptr<StemSource>> sources;
    juce::String title;
    int slot = 0;
    int stemCount = 0;
    bool active = false;
    bool paused = false;
    double pausedPositionSeconds = 0.0;
    float masterGain = 1.0f;
    float fadeStep = 0.0f;
    bool fadeOutActive = false;

    PlaybackSession()
    {
        formatManager.registerBasicFormats();
        readAheadThread.startThread();
    }

    ~PlaybackSession()
    {
        stop();
    }

    void stop()
    {
        routedSource.setPaused(true);
        manager.removeAudioCallback(&sourcePlayer);
        sourcePlayer.setSource(nullptr);
        sources.clear();
        active = false;
        paused = false;
        pausedPositionSeconds = 0.0;
        masterGain = 1.0f;
        fadeStep = 0.0f;
        fadeOutActive = false;
    }

    void pause()
    {
        pausedPositionSeconds = currentPositionSeconds();
        for (auto& source : sources)
        {
            source->transport->setPosition(pausedPositionSeconds);
            source->transport->stop();
        }

        routedSource.setPaused(true);
        paused = true;
    }

    void resume()
    {
        for (auto& source : sources)
        {
            source->transport->setPosition(pausedPositionSeconds);
            source->transport->start();
        }

        routedSource.seekTo(pausedPositionSeconds);
        routedSource.setPaused(false);
        paused = false;
    }

    void seekTo(double seconds)
    {
        const auto target = juce::jmax(0.0, seconds);
        pausedPositionSeconds = target;
        for (auto& source : sources)
            source->transport->setPosition(target);

        routedSource.seekTo(target);
    }

    bool triggerCueFile(const juce::String& cueId, const juce::String& cueName, const juce::String& filePath)
    {
        auto sample = loadClickSample(formatManager, filePath);
        if (! sample.isReady())
            return false;

        DynamicCueEvent cue;
        cue.id = cueId;
        cue.name = cueName;
        cue.triggerTimeSeconds = currentPositionSeconds();
        cue.sample = std::move(sample);
        routedSource.triggerDynamicCueNow(std::move(cue));
        return true;
    }

    double currentPositionSeconds() const
    {
        if (sources.empty() || sources.front()->transport == nullptr)
            return pausedPositionSeconds;

        return juce::jmax(0.0, sources.front()->transport->getCurrentPosition());
    }

    void setMasterGain(float nextGain)
    {
        masterGain = juce::jlimit(0.0f, 1.0f, nextGain);

        for (auto& source : sources)
            source->transport->setGain(masterGain * source->baseGain);
    }

    void applyMixer(const juce::Array<juce::var>* stems)
    {
        if (stems == nullptr)
            return;

        bool anySolo = false;

        for (auto& stemValue : *stems)
        {
            auto* stem = stemValue.getDynamicObject();
            if (stem != nullptr)
                anySolo = anySolo || static_cast<bool>(stem->getProperty("solo"));
        }

        for (auto& source : sources)
        {
            for (auto& stemValue : *stems)
            {
                auto* stem = stemValue.getDynamicObject();

                if (stem == nullptr || stem->getProperty("id").toString() != source->id)
                    continue;

                source->baseGain = static_cast<float>(juce::jlimit(0.0, 1.0, static_cast<double>(stem->getProperty("volume")) / 100.0));
                source->solo = static_cast<bool>(stem->getProperty("solo"));
                source->outputChannels = readOutputChannels(stem, source->outputChannels);
                source->iemOutputChannels = readIemOutputChannels(stem);
                const auto audible = ! anySolo || source->solo;
                source->transport->setGain(audible ? masterGain * source->baseGain : 0.0f);
                break;
            }
        }
    }

    void applyDynamicMixer(juce::DynamicObject* dynamicClick, juce::DynamicObject* dynamicCue, juce::DynamicObject* dynamicPad)
    {
        const juce::Array<int> defaultClickOutputs { 3 };
        const juce::Array<int> defaultDynamicCueOutputs { 4 };
        const juce::Array<int> defaultPadOutputs { 5, 6 };
        routedSource.updateDynamicMixer(readOutputChannels(dynamicClick, defaultClickOutputs),
                                        gainFromMixerObject(dynamicClick),
                                        readOutputChannels(dynamicCue, defaultDynamicCueOutputs),
                                        gainFromMixerObject(dynamicCue),
                                        readOutputChannels(dynamicPad, defaultPadOutputs),
                                        gainFromMixerObject(dynamicPad),
                                        dynamicPad != nullptr && static_cast<bool>(dynamicPad->getProperty("active")));
    }

    void startFadeOut(int durationMs)
    {
        const auto steps = juce::jmax(1, durationMs / 20);
        fadeStep = masterGain / static_cast<float>(steps);
        fadeOutActive = true;
    }

    void advanceFade()
    {
        if (! fadeOutActive)
            return;

        setMasterGain(masterGain - fadeStep);

        if (masterGain <= 0.001f)
            stop();
    }
};


juce::DynamicObject* findManifestSong(juce::DynamicObject* manifest, int slot)
{
    if (manifest == nullptr)
        return nullptr;

    auto* songs = manifest->getProperty("songs").getArray();

    if (songs == nullptr)
        return nullptr;

    for (auto& songValue : *songs)
    {
        auto* song = songValue.getDynamicObject();

        if (song != nullptr && static_cast<int>(song->getProperty("slot")) == slot)
            return song;
    }

    return nullptr;
}

juce::Array<int> readRouteOutputChannels(juce::DynamicObject* object, const juce::Identifier& routeProperty, const juce::Array<int>& fallback)
{
    juce::Array<int> channels;

    if (object != nullptr)
    {
        auto* routing = object->getProperty(routeProperty).getDynamicObject();
        auto* outputChannels = routing != nullptr ? routing->getProperty("outputChannels").getArray() : nullptr;

        if (outputChannels != nullptr)
            for (auto& channel : *outputChannels)
                channels.addIfNotAlreadyThere(static_cast<int>(channel));
    }

    return channels.isEmpty() ? fallback : channels;
}

juce::Array<int> readOutputChannels(juce::DynamicObject* object, const juce::Array<int>& fallback)
{
    return readRouteOutputChannels(object, juce::Identifier("routing"), fallback);
}

juce::Array<int> readIemOutputChannels(juce::DynamicObject* object)
{
    juce::Array<int> noSend;

    if (object == nullptr || ! static_cast<bool>(object->getProperty("iemSend")))
        return noSend;

    return readRouteOutputChannels(object, juce::Identifier("iemRouting"), noSend);
}

float gainFromMixerObject(juce::DynamicObject* object)
{
    if (object == nullptr)
        return 0.8f;

    return static_cast<float>(juce::jlimit(0.0, 1.0, static_cast<double>(object->getProperty("volume")) / 100.0));
}

juce::Array<int> readPresetRouteChannels(juce::DynamicObject* manifest, const juce::String& routeName, const juce::Array<int>& fallback)
{
    auto* preset = manifest != nullptr ? manifest->getProperty("routingPreset").getDynamicObject() : nullptr;
    auto* routes = preset != nullptr ? preset->getProperty("routes").getDynamicObject() : nullptr;
    auto* route = routes != nullptr ? routes->getProperty(routeName).getArray() : nullptr;
    juce::Array<int> channels;

    if (route != nullptr)
        for (auto& channel : *route)
            channels.addIfNotAlreadyThere(static_cast<int>(channel));

    return channels.isEmpty() ? fallback : channels;
}

int maxChannelInRoute(const juce::Array<int>& channels)
{
    int maxChannel = 0;

    for (int channel : channels)
        maxChannel = juce::jmax(maxChannel, channel);

    return maxChannel;
}

double readSongBpm(juce::DynamicObject* song)
{
    auto* dynamicClick = song != nullptr ? song->getProperty("dynamicClick").getDynamicObject() : nullptr;
    auto* tempoMap = dynamicClick != nullptr ? dynamicClick->getProperty("tempoMap").getDynamicObject() : nullptr;
    const auto bpm = tempoMap != nullptr ? static_cast<double>(tempoMap->getProperty("bpm")) : 0.0;
    return bpm > 0.0 ? bpm : 120.0;
}

juce::String readDynamicClickPath(juce::DynamicObject* song, const juce::Identifier& property)
{
    auto* dynamicClick = song != nullptr ? song->getProperty("dynamicClick").getDynamicObject() : nullptr;
    return dynamicClick != nullptr ? dynamicClick->getProperty(property).toString() : juce::String();
}

juce::String readDynamicPadPath(juce::DynamicObject* song)
{
    auto* dynamicPad = song != nullptr ? song->getProperty("dynamicPad").getDynamicObject() : nullptr;
    return dynamicPad != nullptr ? dynamicPad->getProperty("filePath").toString() : juce::String();
}

ClickSample loadClickSample(juce::AudioFormatManager& formatManager, const juce::String& filePath)
{
    ClickSample sample;
    const juce::File file(filePath);

    if (filePath.isEmpty() || ! file.existsAsFile())
        return sample;

    std::unique_ptr<juce::AudioFormatReader> reader(formatManager.createReaderFor(file));

    if (reader == nullptr || reader->lengthInSamples <= 0)
        return sample;

    sample.sourceSampleRate = reader->sampleRate > 0.0 ? reader->sampleRate : 48000.0;
    juce::AudioBuffer<float> sourceBuffer(static_cast<int>(reader->numChannels), static_cast<int>(reader->lengthInSamples));
    reader->read(&sourceBuffer, 0, sourceBuffer.getNumSamples(), 0, true, true);
    sample.buffer.setSize(1, sourceBuffer.getNumSamples());
    sample.buffer.clear();

    for (int channel = 0; channel < sourceBuffer.getNumChannels(); ++channel)
        sample.buffer.addFrom(0, 0, sourceBuffer, channel, 0, sourceBuffer.getNumSamples(), 1.0f / static_cast<float>(sourceBuffer.getNumChannels()));

    return sample;
}

std::vector<ClickBeat> readSongClickGrid(juce::DynamicObject* song)
{
    std::vector<ClickBeat> beats;
    auto* dynamicClick = song != nullptr ? song->getProperty("dynamicClick").getDynamicObject() : nullptr;
    auto* clickEvents = dynamicClick != nullptr ? dynamicClick->getProperty("clickEvents").getArray() : nullptr;

    if (clickEvents != nullptr && ! clickEvents->isEmpty())
    {
        for (auto& eventValue : *clickEvents)
        {
            auto* eventObject = eventValue.getDynamicObject();
            if (eventObject == nullptr)
                continue;

            const auto timeSeconds = static_cast<double>(eventObject->getProperty("timeSeconds"));
            if (timeSeconds < 0.0)
                continue;

            ClickBeat beat;
            beat.timeSeconds = timeSeconds;
            beat.strong = eventObject->getProperty("type").toString() == "accent";
            beats.push_back(beat);
        }

        std::sort(beats.begin(), beats.end(), [](const ClickBeat& left, const ClickBeat& right) {
            return left.timeSeconds < right.timeSeconds;
        });
        return beats;
    }

    auto* tempoMap = dynamicClick != nullptr ? dynamicClick->getProperty("tempoMap").getDynamicObject() : nullptr;
    auto* beatGrid = tempoMap != nullptr ? tempoMap->getProperty("beatGrid").getArray() : nullptr;
    auto* pattern = dynamicClick != nullptr ? dynamicClick->getProperty("pattern").getArray() : nullptr;
    const auto hasPattern = pattern != nullptr && ! pattern->isEmpty();
    int patternIndex = 0;

    if (beatGrid == nullptr)
        return beats;

    for (auto& beatValue : *beatGrid)
    {
        auto* beatObject = beatValue.getDynamicObject();
        if (beatObject == nullptr)
            continue;

        const auto timeSeconds = static_cast<double>(beatObject->getProperty("timeSeconds"));
        if (timeSeconds < 0.0)
            continue;

        ClickBeat beat;
        beat.timeSeconds = timeSeconds;
        if (hasPattern)
        {
            const auto patternValue = pattern->getReference(patternIndex % pattern->size()).toString();
            beat.strong = patternValue == "accent";
            ++patternIndex;
        }
        else
        {
            beat.strong = static_cast<bool>(beatObject->getProperty("isDownbeat"))
                || static_cast<int>(beatObject->getProperty("beat")) == 1;
        }
        beats.push_back(beat);
    }

    return beats;
}

std::vector<DynamicCueEvent> readSongDynamicCues(juce::DynamicObject* song, juce::AudioFormatManager& formatManager)
{
    std::vector<DynamicCueEvent> cues;
    auto* dynamicCues = song != nullptr ? song->getProperty("dynamicCues").getArray() : nullptr;

    if (dynamicCues == nullptr)
        return cues;

    for (auto& cueValue : *dynamicCues)
    {
        auto* cueObject = cueValue.getDynamicObject();
        if (cueObject == nullptr || cueObject->getProperty("status").toString() != "matched")
            continue;

        const auto filePath = cueObject->getProperty("filePath").toString();
        auto sample = loadClickSample(formatManager, filePath);
        if (! sample.isReady())
            continue;

        DynamicCueEvent cue;
        cue.id = cueObject->getProperty("cueId").toString();
        cue.name = cueObject->getProperty("cueName").toString();
        cue.triggerTimeSeconds = juce::jmax(0.0, static_cast<double>(cueObject->getProperty("triggerTimeSeconds")));
        cue.sample = std::move(sample);
        cues.push_back(std::move(cue));
    }

    return cues;
}

void sendPlaybackResult(PlaybackSession& session,
                        const juce::String& requestId,
                        const juce::String& manifestPath,
                        int slot,
                        const juce::String& deviceName,
                        const juce::String& deviceType,
                        double startSeconds)
{
    session.stop();
    const auto playbackStartSeconds = juce::jmax(0.0, startSeconds);
    const juce::File manifestFile(manifestPath);

    if (! manifestFile.existsAsFile())
    {
        sendRejected(requestId, "Engine manifest file is missing.");
        return;
    }

    auto manifestValue = juce::JSON::parse(manifestFile);
    auto* manifest = manifestValue.getDynamicObject();
    auto* song = findManifestSong(manifest, slot);

    if (song == nullptr)
    {
        sendRejected(requestId, "Requested slot is not in the engine manifest.");
        return;
    }

    auto* stems = song->getProperty("stems").getArray();

    if (stems == nullptr || stems->isEmpty())
    {
        sendRejected(requestId, "Requested slot has no cached stems.");
        return;
    }

    const juce::Array<int> defaultTrackOutputs { 1, 2 };
    const juce::Array<int> defaultClickOutputs { 3 };
    const juce::Array<int> defaultDynamicCueOutputs { 4 };
    auto* dynamicClick = song->getProperty("dynamicClick").getDynamicObject();
    auto* dynamicCue = song->getProperty("dynamicCue").getDynamicObject();
    auto* dynamicPad = song->getProperty("dynamicPad").getDynamicObject();
    const auto clickOutputs = readOutputChannels(dynamicClick, defaultClickOutputs);
    const auto dynamicCueOutputs = readOutputChannels(dynamicCue, defaultDynamicCueOutputs);
    const juce::Array<int> defaultPadOutputs { 5, 6 };
    const auto dynamicPadOutputs = readOutputChannels(dynamicPad, defaultPadOutputs);
    const auto clickGain = gainFromMixerObject(dynamicClick);
    const auto dynamicCueGain = gainFromMixerObject(dynamicCue);
    const auto dynamicPadGain = gainFromMixerObject(dynamicPad);

    juce::AudioDeviceManager::AudioDeviceSetup setup;
    setup.outputDeviceName = deviceName;
    const auto requiredOutputs = juce::jmax(maxOutputChannelFromStemRoutes(stems),
                                            juce::jmax(maxChannelInRoute(dynamicPadOutputs),
                                                       juce::jmax(maxChannelInRoute(clickOutputs), maxChannelInRoute(dynamicCueOutputs))));
    const auto requestedOutputs = requestedOutputCountForDevice(deviceName, requiredOutputs);
    configureOutputChannels(setup, requestedOutputs);

    auto error = openManagedDevice(session.manager, setup, deviceType, requestedOutputs);

    if (error.isNotEmpty())
    {
        sendRejected(requestId, "Audio device open failed: " + error);
        return;
    }

    auto* currentDevice = session.manager.getCurrentAudioDevice();

    if (currentDevice == nullptr)
    {
        sendRejected(requestId, "Audio device open failed: no current device.");
        return;
    }

    bool anySolo = false;

    for (auto& stemValue : *stems)
    {
        if (auto* stem = stemValue.getDynamicObject())
            anySolo = anySolo || static_cast<bool>(stem->getProperty("solo"));
    }

    for (auto& stemValue : *stems)
    {
        auto* stem = stemValue.getDynamicObject();

        if (stem == nullptr)
            continue;

        if (anySolo && ! static_cast<bool>(stem->getProperty("solo")))
            continue;

        const juce::File audioFile(stem->getProperty("cachePath").toString());

        if (! audioFile.existsAsFile())
            continue;

        std::unique_ptr<juce::AudioFormatReader> reader(session.formatManager.createReaderFor(audioFile));

        if (reader == nullptr)
            continue;

        auto source = std::make_unique<StemSource>();
        const auto sourceSampleRate = reader->sampleRate;
        source->id = stem->getProperty("id").toString();
        source->name = stem->getProperty("name").toString();
        source->baseGain = static_cast<float>(juce::jlimit(0.0, 1.0, static_cast<double>(stem->getProperty("volume")) / 100.0));
        source->solo = static_cast<bool>(stem->getProperty("solo"));
        source->outputChannels = readOutputChannels(stem, defaultTrackOutputs);
        source->iemOutputChannels = readIemOutputChannels(stem);
        source->readerSource = std::make_unique<juce::AudioFormatReaderSource>(reader.release(), true);
        source->transport = std::make_unique<juce::AudioTransportSource>();
        source->transport->setSource(source->readerSource.get(), 32768, &session.readAheadThread, sourceSampleRate);
        source->transport->setGain(source->baseGain);
        if (playbackStartSeconds > 0.0)
            source->transport->setPosition(playbackStartSeconds);
        source->transport->start();
        session.sources.push_back(std::move(source));
    }

    if (session.sources.empty())
    {
        sendRejected(requestId, "No readable cached stems were available for playback.");
        return;
    }

    auto clickSample = loadClickSample(session.formatManager, readDynamicClickPath(song, juce::Identifier("clickSoundPath")));
    auto accentSample = loadClickSample(session.formatManager, readDynamicClickPath(song, juce::Identifier("accentSoundPath")));
    auto dynamicPadSample = loadClickSample(session.formatManager, readDynamicPadPath(song));

    session.routedSource.setSources(&session.sources);
    session.routedSource.setDynamicClick(readSongBpm(song), clickOutputs, clickGain, readSongClickGrid(song), std::move(clickSample), std::move(accentSample));
    session.routedSource.setDynamicCues(readSongDynamicCues(song, session.formatManager), dynamicCueOutputs, dynamicCueGain);
    session.routedSource.setDynamicPad(dynamicPadOutputs, dynamicPadGain, std::move(dynamicPadSample));
    session.routedSource.setPaused(false);
    session.sourcePlayer.setSource(&session.routedSource);
    if (playbackStartSeconds > 0.0)
        session.routedSource.seekTo(playbackStartSeconds);
    session.manager.addAudioCallback(&session.sourcePlayer);
    session.active = true;
    session.paused = false;
    session.slot = slot;
    session.title = song->getProperty("title").toString();
    session.stemCount = static_cast<int>(session.sources.size());

    auto response = makeBaseResponse("playbackStarted", requestId);
    response->setProperty("nativeAudioActive", true);
    response->setProperty("deviceName", currentDevice->getName());
    response->setProperty("deviceType", currentDevice->getTypeName());
    response->setProperty("sampleRate", currentDevice->getCurrentSampleRate());
    response->setProperty("bufferSize", currentDevice->getCurrentBufferSizeSamples());
    response->setProperty("requestedOutputChannels", requestedOutputs);
    response->setProperty("outputChannels", currentDevice->getActiveOutputChannels().countNumberOfSetBits());
    response->setProperty("slot", slot);
    response->setProperty("title", session.title);
    response->setProperty("stemCount", session.stemCount);
    writeJsonLine(juce::var(response.get()));
}

void sendAccepted(const juce::String& requestId, const juce::String& commandType)
{
    auto response = makeBaseResponse("accepted", requestId);
    response->setProperty("command", commandType);
    response->setProperty("nativeAudioActive", true);
    writeJsonLine(juce::var(response.get()));
}

void sendSessionAccepted(const juce::String& requestId, const juce::String& type, const PlaybackSession& session)
{
    auto response = makeBaseResponse(type, requestId);
    response->setProperty("nativeAudioActive", session.active);
    response->setProperty("slot", session.slot);
    response->setProperty("title", session.title);
    response->setProperty("stemCount", session.stemCount);
    response->setProperty("paused", session.paused);
    writeJsonLine(juce::var(response.get()));
}

void sendMeterSnapshot(const juce::String& requestId, PlaybackSession& session)
{
    auto response = makeBaseResponse("meterUpdate", requestId);
    response->setProperty("nativeAudioActive", session.active);
    response->setProperty("slot", session.slot);
    response->setProperty("title", session.title);
    juce::Array<juce::var> stems;
    for (const auto& meter : session.routedSource.readStemMeters())
    {
        juce::DynamicObject::Ptr item = new juce::DynamicObject();
        item->setProperty("id", meter.id);
        item->setProperty("name", meter.name);
        item->setProperty("level", meter.level);
        stems.add(juce::var(item.get()));
    }
    response->setProperty("stems", stems);
    writeJsonLine(juce::var(response.get()));
}

int runCommand(PlaybackSession& session, const juce::String& line)
{
    auto parsed = juce::JSON::parse(line);
    auto* object = parsed.getDynamicObject();
    const auto requestId = getRequestId(object);

    if (object == nullptr)
    {
        sendRejected(requestId, "Invalid JSON.");
        return 0;
    }

    const auto type = object->getProperty("type").toString();

    if (type == "hello")
    {
        sendReady(requestId);
        return 0;
    }

    if (type == "listDevices")
    {
        sendDevices(requestId);
        return 0;
    }

    if (type == "testTone")
    {
        const auto deviceName = object->getProperty("deviceName").toString();
        const auto deviceType = object->getProperty("deviceType").toString();
        const auto durationMs = juce::jlimit(250, 5000, static_cast<int>(object->getProperty("durationMs")));
        sendToneResult(requestId, deviceName, deviceType, durationMs);
        return 0;
    }

    if (type == "probeDevice")
    {
        const auto deviceName = object->getProperty("deviceName").toString();
        const auto deviceType = object->getProperty("deviceType").toString();
        const auto requestedOutputs = juce::jlimit(1, 64, static_cast<int>(object->getProperty("requestedOutputChannels")));
        sendDeviceProbe(requestId, deviceName, deviceType, requestedOutputs);
        return 0;
    }

    if (type == "playSlot")
    {
        const auto manifestPath = object->getProperty("manifestPath").toString();
        const auto deviceName = object->getProperty("deviceName").toString();
        const auto deviceType = object->getProperty("deviceType").toString();
        const auto slot = juce::jmax(1, static_cast<int>(object->getProperty("slot")));
        const auto startSeconds = juce::jmax(0.0, static_cast<double>(object->getProperty("startSeconds")));
        sendPlaybackResult(session, requestId, manifestPath, slot, deviceName, deviceType, startSeconds);
        return 0;
    }

    if (type == "pause")
    {
        session.pause();
        sendSessionAccepted(requestId, "playbackPaused", session);
        return 0;
    }

    if (type == "resume")
    {
        session.resume();
        sendSessionAccepted(requestId, "playbackResumed", session);
        return 0;
    }

    if (type == "seek")
    {
        const auto seconds = juce::jmax(0.0, static_cast<double>(object->getProperty("seconds")));
        session.seekTo(seconds);
        sendSessionAccepted(requestId, "playbackSeeked", session);
        return 0;
    }

    if (type == "triggerCue")
    {
        const auto filePath = object->getProperty("filePath").toString();
        const auto cueId = object->getProperty("cueId").toString();
        const auto cueName = object->getProperty("cueName").toString();
        if (! session.triggerCueFile(cueId, cueName, filePath))
        {
            sendRejected(requestId, "Cue WAV could not be loaded.");
            return 0;
        }
        sendSessionAccepted(requestId, "cueTriggered", session);
        return 0;
    }

    if (type == "updateMixer")
    {
        session.applyMixer(object->getProperty("stems").getArray());
        sendSessionAccepted(requestId, "mixerUpdated", session);
        return 0;
    }

    if (type == "updateDynamicMixer")
    {
        session.applyDynamicMixer(object->getProperty("dynamicClick").getDynamicObject(),
                                  object->getProperty("dynamicCue").getDynamicObject(),
                                  object->getProperty("dynamicPad").getDynamicObject());
        sendSessionAccepted(requestId, "dynamicMixerUpdated", session);
        return 0;
    }

    if (type == "getMeters")
    {
        sendMeterSnapshot(requestId, session);
        return 0;
    }

    if (type == "stop")
    {
        session.stop();
        sendSessionAccepted(requestId, "playbackStopped", session);
        return 1;
    }

    if (type == "fadeOut")
    {
        const auto durationMs = juce::jlimit(100, 10000, static_cast<int>(object->getProperty("durationMs")));
        const auto steps = juce::jmax(1, durationMs / 20);
        const auto startGain = session.masterGain;

        for (int i = 1; i <= steps; ++i)
        {
            session.setMasterGain(startGain * (1.0f - static_cast<float>(i) / static_cast<float>(steps)));
            juce::Thread::sleep(20);
        }

        session.stop();
        sendSessionAccepted(requestId, "playbackFadedOut", session);
        return 1;
    }

    if (type == "quit")
    {
        session.stop();
        return 1;
    }

    sendAccepted(requestId, type);
    return 0;
}
}

int main(int argc, char* argv[])
{
    juce::ignoreUnused(argc, argv);
    juce::ScopedJuceInitialiser_GUI juceInitialiser;
    PlaybackSession session;

    std::string input;
    while (std::getline(std::cin, input))
    {
        if (runCommand(session, juce::String(input)) != 0)
            break;
    }

    return 0;
}
